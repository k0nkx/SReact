(() => {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { React, ReactNative } = vendetta.metro.common;
    const { before, after, instead } = vendetta.patcher;
    const { findInReactTree } = vendetta.utils;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { storage } = vendetta.plugin;
    const { useProxy } = vendetta.storage;
    const log = vendetta.logger;

    // Discord's own toast container crashes ("Cannot read property 'position' of undefined"),
    // so use the native Android toast instead. Falls back to an alert on other platforms.
    // v3: no toasts at all. The run just finishes silently; status goes to the debug logs.
    const showToast = msg => {
        try { log.info("Reaction Spam: " + String(msg ?? "")); } catch (e) {}
    };

    // Discord's hard limit is 20 unique reactions per message. Hitting it makes Discord itself
    // pop its (broken) "max reactions" toast and crash, so stay one under the limit.
    const MAX_REACTIONS = 19;
    const DEFAULT_EMOJIS = "😂 💀 🔥 😭 👍 👎 ❤️ 😈 🤡 💯 👀 🙏 😎 🤔 🥶 🤯 😡 🎉 🫡 🗿";

    let RestAPI, ActionSheet;
    const unpatches = [];
    let unpatchSheet;
    let running = false;
    let cancelled = false;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ---- Emoji parsing ------------------------------------------------------------

    // Looks up custom server emojis by name (for ":skullcry:" style input) using Discord's emoji store.
    let EmojiStore, GuildStore;
    const restEmojis = [];              // emojis fetched straight from Discord's API as a fallback
    const restFetchedGuilds = new Set();
    const missingShortcodes = [];       // :names: the last parse couldn't resolve

    // Fallback: if the emoji store doesn't know a :name:, ask Discord's API for the emojis of
    // the servers you're in until every missing name has been found.
    async function loadRestEmojis() {
        if (!RestAPI?.get) return;
        const wanted = missingShortcodes.map(n => n.toLowerCase());
        const found = () => wanted.every(n => restEmojis.some(e => e.name.toLowerCase() === n));
        try {
            const res = await RestAPI.get({ url: "/users/@me/guilds" });
            for (const g of res?.body ?? []) {
                if (found()) break;
                if (!g?.id || restFetchedGuilds.has(g.id)) continue;
                restFetchedGuilds.add(g.id);
                try {
                    const r = await RestAPI.get({ url: `/guilds/${g.id}/emojis` });
                    for (const e of r?.body ?? []) {
                        if (typeof e?.id === "string" && typeof e?.name === "string") restEmojis.push(e);
                    }
                } catch (e) {
                    log.error("Reaction Spam: couldn't load emojis for a server", e);
                }
                await sleep(100);
            }
        } catch (e) {
            log.error("Reaction Spam: couldn't load your servers' emojis", e);
        }
    }

    // Emoji objects have these fields; guilds/roles/users do not (they have ownerId etc.).
    const isEmoji = e => e && typeof e === "object" && typeof e.id === "string" && typeof e.name === "string"
        && !("ownerId" in e) && ("animated" in e || "guildId" in e || "require_colons" in e || "allNamesString" in e);

    function customEmojiList() {
        const list = [];
        const seenIds = new Set();
        let visited = 0;
        // Walk arrays/Maps/plain objects a couple of levels deep and collect anything emoji-shaped.
        const collect = (v, depth) => {
            if (!v || typeof v !== "object" || visited++ > 20000) return;
            if (isEmoji(v)) {
                if (!seenIds.has(v.id)) { seenIds.add(v.id); list.push(v); }
                return;
            }
            if (depth <= 0) return;
            const items = v instanceof Map ? [...v.values()] : Array.isArray(v) ? v : Object.values(v);
            for (const it of items) collect(it, depth - 1);
        };
        const attempt = fn => { try { collect(fn(), 3); } catch (e) { /* try the next source */ } };

        try {
            EmojiStore ??= findByStoreName?.("EmojiStore") ?? findByProps("getCustomEmojiById", "getGuilds");
            GuildStore ??= findByStoreName?.("GuildStore");
            const es = EmojiStore;
            if (es) {
                attempt(() => es.getGuilds?.());
                attempt(() => es.getDisambiguatedEmojiContext?.()?.customEmojis);
                attempt(() => es.getUsableCustomEmojis?.());
                attempt(() => es.getCustomEmojis?.());
                // Per-guild lookups over every guild the user is in.
                try {
                    const guilds = GuildStore?.getGuilds?.() ?? {};
                    for (const id of Object.keys(guilds)) {
                        attempt(() => es.getGuildEmoji?.(id));
                        attempt(() => guilds[id]?.emojis);
                    }
                } catch (e) { /* ignore */ }
                // Last resort: call every zero-argument getter on the store and look for emojis.
                if (!list.length) {
                    const names = new Set([...Object.getOwnPropertyNames(es), ...Object.getOwnPropertyNames(Object.getPrototypeOf(es) ?? {})]);
                    for (const n of names) {
                        if (/^get/.test(n) && typeof es[n] === "function" && es[n].length === 0) attempt(() => es[n]());
                    }
                }
            }
        } catch (e) {
            log.error("Reaction Spam: couldn't read the emoji store", e);
        }
        for (const e of restEmojis) {
            if (!seenIds.has(e.id)) { seenIds.add(e.id); list.push(e); }
        }
        // Emojis the user can actually use come first.
        return list.sort((a, b) => (b.available !== false) - (a.available !== false));
    }

    function resolveShortcode(name, getList) {
        const list = getList();
        const lower = name.toLowerCase();
        const hit = list.find(e => e.name === name) ?? list.find(e => e.name.toLowerCase() === lower);
        if (!hit) {
            if (!missingShortcodes.includes(name)) missingShortcodes.push(name);
            log.error(`Reaction Spam: no custom emoji named :${name}: (yet)`);
        }
        return hit ? `${hit.name}:${hit.id}` : null;
    }

    // Accepts unicode emojis, :name: (custom server emoji), <:name:id>, <a:name:id> or name:id,
    // split on spaces/commas.
    function parseEmojis(raw) {
        const out = [];
        const seen = new Set();
        let cache;
        missingShortcodes.length = 0;
        const getList = () => (cache ??= customEmojiList());
        const tokens = String(raw ?? "").match(/<a?:\w+:\d+>|\w+:\d+|[^\s,]+/g) ?? [];
        for (const t of tokens) {
            const custom = t.match(/^<?a?:?(\w+):(\d+)>?$/);
            // Unicode emojis typed with no spaces between them ("😂💀🔥") are split apart here.
            const short = t.match(/^:(\w+):$/);
            const keys = custom ? [`${custom[1]}:${custom[2]}`]
                : short ? [resolveShortcode(short[1], getList)]
                : /[^\x00-\x7F]/.test(t) ? splitEmoji(t) : [t];
            for (const key of keys) {
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push({ key, isCustom: !!(custom || short) });
            }
        }
        // Over the reaction limit: custom emojis win, the rest fill whatever room is left.
        // Without this, a long default list would push your custom emojis past the cap.
        if (out.length > MAX_REACTIONS) {
            let room = MAX_REACTIONS - out.filter(o => o.isCustom).length;
            return out.filter(o => o.isCustom || room-- > 0).slice(0, MAX_REACTIONS).map(o => o.key);
        }
        return out.map(o => o.key);
    }

    // Splits a run of emojis into individual emojis, keeping skin tones, ZWJ sequences,
    // variation selectors, keycaps and flags together.
    function splitEmoji(str) {
        const cps = Array.from(str);
        const isMod = c => {
            const n = c.codePointAt(0);
            return n === 0xFE0F || n === 0xFE0E || n === 0x20E3
                || (n >= 0x1F3FB && n <= 0x1F3FF) || (n >= 0xE0020 && n <= 0xE007F);
        };
        const isFlag = c => {
            const n = c.codePointAt(0);
            return n >= 0x1F1E6 && n <= 0x1F1FF;
        };
        const out = [];
        let i = 0;
        while (i < cps.length) {
            let g = cps[i++];
            if (isFlag(g) && i < cps.length && isFlag(cps[i])) g += cps[i++];
            while (i < cps.length) {
                if (isMod(cps[i])) g += cps[i++];
                else if (cps[i] === "\u200D" && i + 1 < cps.length) { g += cps[i] + cps[i + 1]; i += 2; }
                else break;
            }
            out.push(g);
        }
        return out;
    }

    // ---- Reacting -----------------------------------------------------------------

    function addReaction(channelId, messageId, emoji) {
        return RestAPI.put({
            url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
            query: { location: "Message Reaction Picker", type: 0 }
        });
    }

    function errorStatus(e) {
        return e?.status ?? e?.statusCode ?? e?.response?.status ?? e?.body?.status;
    }

    function errorText(e) {
        const status = errorStatus(e);
        const msg = e?.body?.message ?? e?.message ?? (typeof e === "string" ? e : "");
        return [status, msg].filter(Boolean).join(" ") || "unknown error";
    }

    async function spam(message, preset) {
        if (running) return showToast("Reaction spam already running");
        if (!RestAPI?.put) return showToast("Couldn't find Discord's REST API");
        if (!preset) return showToast("That preset no longer exists");

        let emojis = parseEmojis(preset.emojis);
        if (missingShortcodes.length) {
            // The emoji store didn't know some :names:, so ask Discord's API and parse again.
            await loadRestEmojis();
            emojis = parseEmojis(preset.emojis);
        }
        storage.lastRun = `${preset.name || "preset"}: ${emojis.length ? emojis.join(" ") : "nothing to react with"}`
            + (missingShortcodes.length ? ` (not found: ${missingShortcodes.map(n => ":" + n + ":").join(" ")})` : "");
        if (!emojis.length) return showToast("Add some emojis to this preset in the plugin settings first");

        const delay = Math.max(0, parseInt(storage.delay, 10) || 0);
        running = true;
        cancelled = false;
        let sent = 0;
        let failed = 0;
        let lastError = null;

        try {
            for (const emoji of emojis) {
                if (cancelled) break;
                try {
                    await addReaction(message.channel_id, message.id, emoji);
                    sent++;
                } catch (e) {
                    const status = errorStatus(e);
                    if (status === 429) {
                        showToast(`Rate limited (429), stopped after ${sent} reaction(s)`);
                        return;
                    }
                    if (status === 401 || status === 403) {
                        showToast(`No permission to react (${status}), stopped`);
                        return;
                    }
                    // Bad emoji or some other per-emoji failure: skip it and carry on.
                    failed++;
                    lastError = e;
                    log.error("Reaction Spam: failed to add", emoji, e);
                }
                if (delay) await sleep(delay);
            }
            if (cancelled) showToast(`Stopped after ${sent} reaction(s)`);
            else if (!sent && lastError) showToast(`Added 0, all ${failed} failed: ${errorText(lastError)}`);
            else showToast(`Added ${sent}/${emojis.length} reaction(s)${failed ? `, ${failed} failed (${errorText(lastError)})` : ""}`);
        } catch (e) {
            log.error("Reaction Spam:", e);
            showToast("Reaction spam failed, check logs");
        } finally {
            running = false;
        }
    }

    // ---- Toast crash guard --------------------------------------------------------
    // Discord's toast container crashes the whole app when it is handed a toast without a
    // position ("Cannot read property 'position' of undefined"). Vendetta's showToast (used by
    // many plugins) builds exactly that kind of toast, so block it before it reaches the UI.
    function patchToastGuard() {
        try {
            const vdToasts = vendetta.ui.toasts;
            if (vdToasts && typeof vdToasts.showToast === "function") {
                unpatches.push(instead("showToast", vdToasts, () => {}));
            }
        } catch (e) {
            log.error("Reaction Spam: couldn't guard Vendetta toasts", e);
        }
        try {
            // Discord's own toast store: drop any toast that has no position anywhere.
            const store = findByProps("open", "close", "getToasts") ?? findByProps("openToast");
            const fn = store?.open ? "open" : store?.openToast ? "openToast" : null;
            if (store && fn) {
                unpatches.push(instead(fn, store, (args, orig) => {
                    const t = args?.[0];
                    if (t && typeof t === "object" && (t.position ?? t.options?.position) === undefined) return;
                    return orig(...args);
                }));
            }
        } catch (e) {
            log.error("Reaction Spam: couldn't guard Discord toasts", e);
        }
    }

    // ---- Long-press menu ----------------------------------------------------------

    const isRow = el => el?.props && typeof el.props.label === "string" && typeof el.props.onPress === "function";

    function makeRow(template, key, label, iconNames, onPress) {
        const props = { key, label, onPress };
        const iconId = iconNames.map(n => getAssetIDByName?.(n)).find(Boolean);
        const icon = template.props.icon;
        if (iconId && React.isValidElement(icon)) props.icon = React.cloneElement(icon, { source: iconId });
        else if (iconId && typeof icon === "number") props.icon = iconId;
        return React.cloneElement(template, props);
    }

    function addRow(tree, message) {
        const rows = findInReactTree(tree, x => Array.isArray(x) && x.some(isRow));
        if (!rows) return;
        // Discord can reuse the same rows array between renders, so drop our old rows and rebuild
        // them every time instead of skipping. That way they always match the current presets.
        for (let i = rows.length - 1; i >= 0; i--) {
            if (typeof rows[i]?.key === "string" && rows[i].key.startsWith("reaction-spam")) rows.splice(i, 1);
        }
        const template = rows.find(isRow);
        const icons = ["ic_add_reaction_24px", "ReactionIcon", "EmojiNewIcon", "ic_emoji_24px"];
        const hide = () => ActionSheet?.hideActionSheet?.();

        // While a run is going, the only button is Stop.
        if (running) {
            rows.push(makeRow(template, "reaction-spam-stop", "Stop Reaction Spam", icons, () => {
                hide();
                cancelled = true;
                showToast("Stopping...");
            }));
            return;
        }

        // One menu button per preset.
        (storage.presets ?? []).map(plain).forEach((snap, i) => {
            rows.push(makeRow(template, `reaction-spam-${i}-${snap.id}`, snap.name || "Spam Reactions", icons, () => {
                hide();
                const live = storage.presets?.[i];
                spam(message, live ? plain(live) : snap);
            }));
        });
    }

    function patchSheet() {
        ActionSheet = findByProps("openLazy", "hideActionSheet");
        if (!ActionSheet) return log.error("Reaction Spam: couldn't find the action sheet module");

        unpatches.push(before("openLazy", ActionSheet, ([lazy, key]) => {
            if (unpatchSheet || typeof key !== "string" || !key.includes("MessageLongPress")) return;
            Promise.resolve(lazy).then(mod => {
                if (unpatchSheet || !mod) return;
                const [target, prop] = typeof mod.default === "function" ? [mod, "default"]
                    : typeof mod.default?.type === "function" ? [mod.default, "type"] : [];
                if (!target) return log.error("Reaction Spam: unexpected message menu shape");
                unpatchSheet = after(prop, target, ([props], tree) => {
                    try {
                        if (props?.message?.id) addRow(tree, props.message);
                    } catch (e) {
                        log.error("Reaction Spam: couldn't add menu button", e);
                    }
                });
            }).catch(e => log.error("Reaction Spam: action sheet error", e));
        }));
    }

    // ---- Settings -----------------------------------------------------------------

    const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const plain = p => ({ id: p.id, name: p.name, emojis: p.emojis });

    function Settings() {
        useProxy(storage);
        const { ScrollView, View, Text, TextInput, TouchableOpacity } = ReactNative;

        const label = { color: "#ffffff", fontSize: 16, fontWeight: "600", marginBottom: 6 };
        const hint = { color: "#b5bac1", fontSize: 13, marginTop: 6 };
        const input = {
            color: "#ffffff",
            backgroundColor: "#1e1f22",
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 16
        };
        const card = { backgroundColor: "#2b2d31", borderRadius: 12, padding: 14, gap: 12 };

        const presets = (Array.isArray(storage.presets) ? storage.presets : []).map(plain);
        const update = (i, patch) => { storage.presets = presets.map((p, j) => j === i ? { ...p, ...patch } : p); };
        const remove = i => { storage.presets = presets.filter((p, j) => j !== i); };
        const add = () => { storage.presets = [...presets, { id: newId(), name: "New preset", emojis: "" }]; };

        const button = (text, onPress, color) => React.createElement(TouchableOpacity, {
            onPress,
            style: { backgroundColor: color, borderRadius: 8, paddingVertical: 10, alignItems: "center" }
        }, React.createElement(Text, { style: { color: "#ffffff", fontWeight: "600", fontSize: 15 } }, text));

        const presetCards = presets.map((p, i) => React.createElement(View, { key: `${i}-${p.id}`, style: card },
            React.createElement(View, null,
                React.createElement(Text, { style: label }, "Button name"),
                React.createElement(TextInput, {
                    style: input,
                    value: p.name ?? "",
                    placeholder: "e.g. Flame Skull",
                    placeholderTextColor: "#80848e",
                    onChangeText: v => update(i, { name: v })
                })
            ),
            React.createElement(View, null,
                React.createElement(Text, { style: label }, "Emojis (max 19)"),
                React.createElement(TextInput, {
                    style: { ...input, minHeight: 80, textAlignVertical: "top" },
                    multiline: true,
                    value: p.emojis ?? "",
                    placeholder: "😂 💀 🔥  or  :skullcry:  or  <:name:id>",
                    placeholderTextColor: "#80848e",
                    onChangeText: v => update(i, { emojis: v })
                })
            ),
            button("Delete this button", () => remove(i), "#da373c")
        ));

        return React.createElement(ScrollView, { contentContainerStyle: { padding: 16, gap: 20 } },
            React.createElement(Text, { style: hint }, "Reaction Spam v10 (presets)"),
            React.createElement(Text, { style: hint }, "Last run: " + (storage.lastRun ?? "none yet")),
            React.createElement(Text, { style: hint }, (() => {
                try { return "Custom emojis Discord has loaded: " + customEmojiList().length; } catch (e) { return "Custom emoji lookup failed"; }
            })()),
            React.createElement(Text, { style: hint },
                "Each preset below becomes its own button when you long press a message. " +
                "Use spaces or commas between emojis. Custom server emojis: :name: (e.g. :skullcry:), <:name:id> or name:id. " +
                "Discord allows 20 unique reactions per message, so each preset is capped at 19."),
            ...presetCards,
            button("+ Add a new button", add, "#5865f2"),
            React.createElement(View, null,
                React.createElement(Text, { style: label }, "Delay between reactions (ms)"),
                React.createElement(TextInput, {
                    style: input,
                    value: String(storage.delay ?? ""),
                    placeholder: "400",
                    placeholderTextColor: "#80848e",
                    keyboardType: "numeric",
                    onChangeText: v => { storage.delay = v.replace(/[^0-9]/g, ""); }
                }),
                React.createElement(Text, { style: hint },
                    "Applies to every button. It stops straight away on a 429. Raise the delay if you keep hitting it.")
            )
        );
    }

    return {
        onLoad() {
            if (!Array.isArray(storage.presets)) {
                // First run on this version: your old emoji list becomes the first button.
                storage.presets = [{ id: "default", name: "Spam Reactions", emojis: storage.emojis ?? DEFAULT_EMOJIS }];
            }
            {
                // Repair presets saved without an id, or sharing one, so each button is separate.
                const used = new Set();
                storage.presets = storage.presets.map(plain).map(pr => {
                    let id = pr.id;
                    if (!id || used.has(id)) id = newId();
                    used.add(id);
                    return { ...pr, id };
                });
            }
            storage.delay ??= "400";
            RestAPI = findByProps("getAPIBaseURL", "get", "put") ?? findByProps("getAPIBaseURL", "put");
            if (!RestAPI) log.error("Reaction Spam: couldn't find the REST API module");
            patchToastGuard();
            patchSheet();
        },
        onUnload() {
            cancelled = true;
            unpatchSheet?.();
            unpatchSheet = null;
            unpatches.splice(0).forEach(u => u());
        },
        settings: Settings
    };
})()
