(() => {
    const { findByProps } = vendetta.metro;
    const { React, ReactNative } = vendetta.metro.common;
    const { before, after } = vendetta.patcher;
    const { findInReactTree } = vendetta.utils;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { storage } = vendetta.plugin;
    const { useProxy } = vendetta.storage;
    const log = vendetta.logger;

    const MAX_REACTIONS = 20;
    const DEFAULT_EMOJIS = "😂 💀 🔥 😭 👍 👎 ❤️ 😈 🤡 💯 👀 🙏 😎 🤔 🥶 🤯 😡 🎉 🫡 🗿";

    let RestAPI, ActionSheet, ReactionActions;
    const unpatches = [];
    let running = false;
    let cancelled = false;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Never touch Discord's toast system (avoids the position crash)
    function showToast(content) {
        try { log.info("[Reactions]", content); } catch {}
        console.log("[Reactions]", content);
    }

    // ---- Emoji parsing (fixed) ----------------------------------------------------

    // Accepts:
    //   unicode: 😂
    //   custom:  <:name:123>  <a:name:123>  name:123
    function parseEmojis(raw) {
        const out = [];
        const seen = new Set();
        const tokens = String(raw ?? "").match(/<a?:\w+:\d+>|\w+:\d+|[^\s,]+/g) ?? [];

        for (const t of tokens) {
            let apiKey;
            let animated = false;

            // <:name:id> or <a:name:id>
            let m = t.match(/^<(a)?:(\w+):(\d+)>$/);
            if (m) {
                animated = !!m[1];
                apiKey = `\( {m[2]}: \){m[3]}`;
            } else {
                // name:id (no brackets)
                m = t.match(/^(\w+):(\d+)$/);
                if (m) {
                    apiKey = `\( {m[1]}: \){m[2]}`;
                } else {
                    // unicode / anything else
                    apiKey = t;
                }
            }

            if (!apiKey || seen.has(apiKey)) continue;
            seen.add(apiKey);
            out.push({ apiKey, animated });
            if (out.length >= MAX_REACTIONS) break;
        }
        return out;
    }

    // ---- Reacting -----------------------------------------------------------------

    function addReaction(channelId, messageId, apiKey) {
        // Discord expects name:id for custom, or the raw unicode for standard
        const encoded = encodeURIComponent(apiKey);
        return RestAPI.put({
            url: `/channels/\( {channelId}/messages/ \){messageId}/reactions/${encoded}/@me`,
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

    function toEmojiObject(apiKey, animated) {
        const m = String(apiKey).match(/^(\w+):(\d+)$/);
        return m
            ? { id: m[2], name: m[1], animated: !!animated }
            : { id: null, name: apiKey, animated: false };
    }

    async function addReactionFallback(channelId, messageId, apiKey, animated) {
        if (!ReactionActions?.addReaction) throw new Error("no fallback available");
        await ReactionActions.addReaction(
            channelId,
            messageId,
            toEmojiObject(apiKey, animated),
            "Message Reaction Picker"
        );
    }

    async function spam(message) {
        if (running) return showToast("Reaction spam already running");
        if (!RestAPI?.put) return showToast("Couldn't find Discord's REST API");

        // Always read the latest value from storage
        const raw = storage.emojis ?? "";
        const emojis = parseEmojis(raw);

        if (!emojis.length) {
            showToast("Add some emojis in the plugin settings first");
            return;
        }

        const delay = Math.max(0, parseInt(storage.delay, 10) || 0);
        running = true;
        cancelled = false;
        let sent = 0;
        let failed = 0;
        let lastError = null;

        try {
            for (const { apiKey, animated } of emojis) {
                if (cancelled) break;
                try {
                    try {
                        await addReaction(message.channel_id, message.id, apiKey);
                    } catch (e) {
                        const status = errorStatus(e);
                        if (status === 429 || status === 401 || status === 403) throw e;
                        log.error("Reaction Spam: REST add failed, trying fallback", apiKey, e);
                        await addReactionFallback(message.channel_id, message.id, apiKey, animated)
                            .catch(() => { throw e; });
                    }
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
                    failed++;
                    lastError = e;
                    log.error("Reaction Spam: failed to add", apiKey, e);
                }
                if (delay) await sleep(delay);
            }

            if (cancelled) {
                showToast(`Stopped after ${sent} reaction(s)`);
            } else if (!sent && lastError) {
                showToast(`Added 0, all ${failed} failed: ${errorText(lastError)}`);
            } else {
                const extra = failed ? `, \( {failed} failed ( \){errorText(lastError)})` : "";
                showToast(`Added \( {sent} reaction(s) \){extra}`);
            }
        } catch (e) {
            log.error("Reaction Spam:", e);
            showToast("Reaction spam failed, check logs");
        } finally {
            running = false;
        }
    }

    // ---- Long-press menu ----------------------------------------------------------

    function patchSheet() {
        ActionSheet = findByProps("openLazy", "hideActionSheet");
        if (!ActionSheet) {
            log.error("Reaction Spam: couldn't find ActionSheet module");
            return;
        }

        const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow;

        unpatches.push(before("openLazy", ActionSheet, ([lazy, key, data]) => {
            if (typeof key !== "string" || !key.includes("MessageLongPress")) return;

            const msg = data?.message || (data?.messageId
                ? { id: data.messageId, channel_id: data.channel?.id || data.channelId }
                : null);
            if (!msg?.id) return;

            Promise.resolve(lazy).then(mod => {
                if (!mod) return;

                const unpatch = after("default", mod, (_args, component) => {
                    React.useEffect(() => () => { try { unpatch(); } catch {} }, []);

                    try {
                        let rows = findInReactTree(component, x =>
                            Array.isArray(x) &&
                            x.some(child =>
                                child?.type?.name === "ButtonRow" ||
                                child?.type?.name === "ActionSheetRow" ||
                                (child?.props && typeof child.props.label === "string" && typeof child.props.onPress === "function")
                            )
                        );

                        if (!rows) {
                            rows = findInReactTree(component, x =>
                                Array.isArray(x) &&
                                x.length >= 2 &&
                                x.filter(item =>
                                    typeof item?.props?.onPress === "function" ||
                                    item?.props?.label ||
                                    item?.props?.title
                                ).length >= 2
                            );
                        }

                        if (!rows || rows.some(r =>
                            r?.key === "reaction-spam" ||
                            r?.props?.label === "Spam Reactions" ||
                            r?.props?.label === "Stop Reaction Spam"
                        )) return;

                        const label = running ? "Stop Reaction Spam" : "Spam Reactions";
                        const iconId = ["ic_add_reaction_24px", "ReactionIcon", "EmojiNewIcon", "ic_emoji_24px"]
                            .map(n => getAssetIDByName?.(n))
                            .find(Boolean);

                        const onPress = () => {
                            try { ActionSheet.hideActionSheet?.(); } catch {}
                            if (running) {
                                cancelled = true;
                                showToast("Stopping...");
                            } else {
                                spam({
                                    id: msg.id,
                                    channel_id: msg.channel_id || data?.channel?.id || data?.channelId
                                });
                            }
                        };

                        if (ActionSheetRow) {
                            rows.push(React.createElement(ActionSheetRow, {
                                key: "reaction-spam",
                                label,
                                icon: iconId
                                    ? React.createElement(ActionSheetRow.Icon || "img", { source: iconId })
                                    : undefined,
                                onPress
                            }));
                        } else {
                            const template = rows.find(r =>
                                r?.props && typeof r.props.label === "string" && typeof r.props.onPress === "function"
                            );
                            if (template) {
                                const props = { key: "reaction-spam", label, onPress };
                                if (iconId) {
                                    if (React.isValidElement(template.props.icon)) {
                                        props.icon = React.cloneElement(template.props.icon, { source: iconId });
                                    } else {
                                        props.icon = iconId;
                                    }
                                }
                                rows.push(React.cloneElement(template, props));
                            } else {
                                rows.push({ key: "reaction-spam", label, onPress });
                            }
                        }
                    } catch (e) {
                        log.error("Reaction Spam: failed to inject button", e);
                    }
                });
            }).catch(e => log.error("Reaction Spam: action sheet load error", e));
        }));
    }

    // ---- Settings -----------------------------------------------------------------

    function Settings() {
        useProxy(storage);
        const { ScrollView, View, Text, TextInput } = ReactNative;

        const labelStyle = { color: "#ffffff", fontSize: 16, fontWeight: "600", marginBottom: 6 };
        const hint = { color: "#b5bac1", fontSize: 13, marginTop: 6 };
        const input = {
            color: "#ffffff",
            backgroundColor: "#1e1f22",
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 16
        };

        return React.createElement(ScrollView, { contentContainerStyle: { padding: 16, gap: 20 } },
            React.createElement(View, null,
                React.createElement(Text, { style: labelStyle }, "Emojis (max 20)"),
                React.createElement(TextInput, {
                    style: { ...input, minHeight: 80, textAlignVertical: "top" },
                    multiline: true,
                    value: storage.emojis ?? "",
                    placeholder: "😂 💀 🔥  or  <:name:id>  or  <a:name:id>  or  name:id",
                    placeholderTextColor: "#80848e",
                    onChangeText: v => {
                        storage.emojis = v;
                    }
                }),
                React.createElement(Text, { style: hint },
                    "Separate with spaces or commas.\n" +
                    "Custom emoji examples: <:pepe:123456789>  <a:wave:987654321>  pepe:123456789\n" +
                    "Discord only allows 20 unique reactions per message.\n" +
                    "Changes are used the next time you spam.")
            ),
            React.createElement(View, null,
                React.createElement(Text, { style: labelStyle }, "Delay between reactions (ms)"),
                React.createElement(TextInput, {
                    style: input,
                    value: String(storage.delay ?? ""),
                    placeholder: "400",
                    placeholderTextColor: "#80848e",
                    keyboardType: "numeric",
                    onChangeText: v => {
                        storage.delay = v.replace(/[^0-9]/g, "");
                    }
                }),
                React.createElement(Text, { style: hint },
                    "Long press a message → Spam Reactions. Stops on 429.\n" +
                    "Feedback appears in console/logs (toasts disabled to avoid a Discord crash).")
            )
        );
    }

    return {
        onLoad() {
            if (storage.emojis == null || storage.emojis === "") {
                storage.emojis = DEFAULT_EMOJIS;
            }
            if (storage.delay == null || storage.delay === "") {
                storage.delay = "400";
            }

            RestAPI = findByProps("getAPIBaseURL", "get", "put") ?? findByProps("getAPIBaseURL", "put");
            if (!RestAPI) log.error("Reaction Spam: couldn't find the REST API module");

            ReactionActions = findByProps("addReaction", "removeReaction") ?? findByProps("addReaction");

            patchSheet();
        },
        onUnload() {
            cancelled = true;
            unpatches.splice(0).forEach(u => { try { u(); } catch {} });
        },
        settings: Settings
    };
})();
