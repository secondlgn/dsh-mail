window.__ModuleLoader__.load({
	id: "dsh-mail",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region locales
		/** Copy for the mail channel's settings page. */
		const en = {
			title: "Mail channel",
			description: "Drive this machine's agent from a dedicated mailbox.",
			sectionConnection: "Mailbox",
			sectionAccess: "Access",
			sectionBehaviour: "Behaviour",
			enabled: "Channel enabled",
			enabledHint: "Turn the whole channel off without removing its configuration.",
			imapHost: "IMAP host",
			imapHostHint: "For example imap.163.com. NetEase requires the client to identify itself; the plugin does that automatically.",
			imapPort: "IMAP port",
			imapPortHint: "993 for implicit TLS.",
			imapUser: "Mailbox address",
			imapUserHint: "The account the channel polls and sends from.",
			mailbox: "Inbox folder",
			mailboxHint: "Usually INBOX.",
			passwordEnv: "Password environment variable",
			passwordEnvHint: "Name of the environment variable holding the password or app password. Preferred over storing it in the config file.",
			smtpHost: "SMTP host",
			smtpHostHint: "Leave blank to reuse the IMAP host.",
			smtpPort: "SMTP port",
			smtpPortHint: "465 for implicit TLS.",
			saveToSent: "Copy results into the Sent folder",
			allowFrom: "Allowed senders",
			allowFromHint: "One exact address per line. Anyone not listed is ignored entirely — not even a receipt is sent. Empty means nobody can drive this machine.",
			selfAddresses: "Treated as this mailbox",
			selfAddressesHint: "Extra addresses that count as \"us\" for loop suppression. The mailbox address is always included.",
			interruptSameThread: "Interrupt the running turn on a same-thread reply",
			sendReceipt: "Acknowledge receipt immediately",
			sendResult: "Mail the answer when the turn ends",
			workspaceDir: "Working directory",
			workspaceDirHint: "Absolute path used for sessions started by mail. Leave blank to use the process working directory. This is per machine — do not copy it between machines.",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "The mail channel plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default."
		};
		const zh = {
			title: "邮件通道",
			description: "用一台专属邮箱驱动这台机器的 agent。",
			sectionConnection: "邮箱",
			sectionAccess: "准入",
			sectionBehaviour: "行为",
			enabled: "启用通道",
			enabledHint: "整体关闭通道，但保留配置。",
			imapHost: "IMAP 服务器",
			imapHostHint: "例如 imap.163.com。网易要求客户端先自我介绍，插件已自动处理。",
			imapPort: "IMAP 端口",
			imapPortHint: "隐式 TLS 用 993。",
			imapUser: "邮箱地址",
			imapUserHint: "通道收信与发信使用的账号。",
			mailbox: "收件文件夹",
			mailboxHint: "通常是 INBOX。",
			passwordEnv: "密码环境变量名",
			passwordEnvHint: "保存密码或授权码的环境变量名。比写进配置文件更安全，优先用它。",
			smtpHost: "SMTP 服务器",
			smtpHostHint: "留空则复用 IMAP 服务器。",
			smtpPort: "SMTP 端口",
			smtpPortHint: "隐式 TLS 用 465。",
			saveToSent: "结果回信存入「已发送」",
			allowFrom: "白名单发件人",
			allowFromHint: "每行一个完整地址。未列出的发件人会被完全丢弃——连回执都不发。留空表示任何人都无法驱动这台机器。",
			selfAddresses: "视为本机邮箱的地址",
			selfAddressesHint: "用于防自环的额外地址；邮箱本身始终计入。",
			interruptSameThread: "同线程回复打断当前轮次",
			sendReceipt: "收到即回执",
			sendResult: "轮次结束时回信",
			workspaceDir: "工作目录",
			workspaceDirHint: "邮件发起会话的工作目录，必须是绝对路径。留空则用进程当前目录。每台机器都不同，不要照抄。",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "邮件通道插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。"
		};
		//#endregion
		//#region form
		/**
		* The labels the shared settings frame renders.
		* @param t - this page's locale reader.
		* @returns the frame's copy.
		*/
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		/**
		* Read a snapshot selector's value, or undefined while the form is not ready.
		* @param props - the page's props.
		* @returns the form state, or undefined.
		*/
		function readState(props) {
			return props.useMailForm((snapshot) => snapshot);
		}
		/**
		* One text field bound to a config path.
		* @param props - the page's props and the field's copy and path.
		* @returns the control.
		*/
		function TextField(props) {
			const { t, state, field } = props;
			const fieldState = state[field] ?? { text: "", overridden: false, invalid: false };
			return (0, react_jsx_runtime.jsx)(primitives.SettingsValueField, {
				id: `plugin-config-dsh-mail-${field}`,
				label: t(props.label),
				hint: t(props.hint),
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				invalidLabel: t("invalidNumber"),
				numeric: props.numeric === true,
				disabled: !state.writable,
				text: fieldState.text,
				overridden: fieldState.overridden,
				invalid: fieldState.invalid,
				onEdit: (text) => {
					props.edit(field, text);
				},
				onReset: () => {
					props.resetField(field);
				}
			});
		}
		/**
		* A section heading inside the form.
		* @param props - the heading's copy.
		* @returns the heading.
		*/
		function Section(props) {
			return (0, react_jsx_runtime.jsx)("h3", {
				style: { margin: "18px 0 6px", fontSize: "13px", fontWeight: "600" },
				children: props.t(props.label)
			});
		}
		/**
		* The mail channel's page: a one-liner in the Plugins list, the editable form once opened.
		* @param props - the view asked for, the locale reader, the form state, and its actions.
		* @returns the one-liner, or the form.
		*/
		function MailCard(props) {
			const { t } = props;
			if (props.view === "summary") return t("description");
			const state = readState(props);
			if (state === undefined || !state.available) {
				return (0, react_jsx_runtime.jsx)("p", {
					role: "status",
					children: t("unavailable")
				});
			}
			const field = (name, label, hint, numeric) => (0, react_jsx_runtime.jsx)(TextField, {
				t,
				state,
				field: name,
				label,
				hint,
				numeric,
				edit: props.edit,
				resetField: props.resetField
			}, name);
			return (0, react_jsx_runtime.jsx)(primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: (0, react_jsx_runtime.jsxs)("div", {
					children: [
						(0, react_jsx_runtime.jsx)(Section, { t, label: "sectionConnection" }),
						field("imapHost", "imapHost", "imapHostHint", false),
						field("imapPort", "imapPort", "imapPortHint", true),
						field("imapUser", "imapUser", "imapUserHint", false),
						field("mailbox", "mailbox", "mailboxHint", false),
						field("passwordEnv", "passwordEnv", "passwordEnvHint", false),
						field("smtpHost", "smtpHost", "smtpHostHint", false),
						field("smtpPort", "smtpPort", "smtpPortHint", true),
						(0, react_jsx_runtime.jsx)(Section, { t, label: "sectionAccess" }),
						field("allowFrom", "allowFrom", "allowFromHint", false),
						field("selfAddresses", "selfAddresses", "selfAddressesHint", false),
						(0, react_jsx_runtime.jsx)(Section, { t, label: "sectionBehaviour" }),
						field("workspaceDir", "workspaceDir", "workspaceDirHint", false),
						field("interruptSameThread", "interruptSameThread", "", false),
						field("sendReceipt", "sendReceipt", "", false),
						field("sendResult", "sendResult", "", false),
						field("saveToSent", "saveToSent", "", false),
						field("enabled", "enabled", "enabledHint", false)
					]
				})
			});
		}
		//#endregion
		//#region controller
		/** Runtime config paths this page edits, as `path` plus the shape of its section value. */
		const SPECS = [
			{ field: "imapHost", path: ["imap", "host"], format: (value) => typeof value === "string" ? value : "" },
			{ field: "imapPort", path: ["imap", "port"], number: true },
			{ field: "imapUser", path: ["imap", "user"], format: (value) => typeof value === "string" ? value : "" },
			{ field: "mailbox", path: ["imap", "mailbox"], format: (value) => typeof value === "string" ? value : "" },
			{ field: "passwordEnv", path: ["imap", "passwordEnv"], format: (value) => typeof value === "string" ? value : "" },
			{ field: "smtpHost", path: ["smtp", "host"], format: (value) => typeof value === "string" ? value : "" },
			{ field: "smtpPort", path: ["smtp", "port"], number: true },
			{ field: "allowFrom", path: ["allowFrom"], text: true },
			{ field: "selfAddresses", path: ["selfAddresses"], text: true },
			{ field: "workspaceDir", path: ["workspaceDir"], format: (value) => typeof value === "string" ? value : "" },
			{ field: "interruptSameThread", path: ["interruptSameThread"], flag: true },
			{ field: "sendReceipt", path: ["sendReceipt"], flag: true },
			{ field: "sendResult", path: ["sendResult"], flag: true },
			{ field: "saveToSent", path: ["smtp", "saveToSent"], flag: true },
			{ field: "enabled", path: ["enabled"], flag: true }
		];
		/** Read a nested value out of the namespace section. */
		function sectionValue(section, path) {
			return path.reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), section);
		}
		/** Render a scalar as the text the control shows. */
		function formatScalar(value) {
			if (typeof value === "string") return value;
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			return "";
		}
		/** Render a list as one-entry-per-line text. */
		function formatList(value) {
			return Array.isArray(value) ? value.join("\n") : "";
		}
		/**
		* Compare two form projections by value so an unchanged read does not re-render the page.
		* @param left - the previous projection.
		* @param right - the current projection.
		* @returns whether they render the same.
		*/
		function shallowEqual(left, right) {
			const leftKeys = Object.keys(left);
			if (leftKeys.length !== Object.keys(right).length) return false;
			for (const key of leftKeys) {
				const a = left[key];
				const b = right[key];
				if (a === b) continue;
				if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
				const fields = Object.keys(a);
				if (fields.length !== Object.keys(b).length) return false;
				for (const field of fields) if (a[field] !== b[field]) return false;
			}
			return true;
		}
		/**
		* Stages edits over the `dsh-mail` namespace and writes them on save.
		*
		* `SettingsFormModel` only understands flat fields whose spec formats and parses the section
		* value, but this plugin's settings are nested (`imap.host`) or lists (`allowFrom`). The specs
		* below therefore format the *path* value the model hands them, and every accepted edit is
		* converted into a `configForms` path operation — the same shape the model would submit for a
		* flat field.
		*/
		var MailFormController = class {
			/** @param scope - the bound configuration form for the `dsh-mail` namespace. */
			constructor(scope) {
				this.scope = scope;
				this.specs = new Map(SPECS.map((spec) => [spec.field, spec]));
				this.draft = /* @__PURE__ */ new Map();
				this.listeners = /* @__PURE__ */ new Set();
				this.saving = false;
				this.failed = false;
				this.unsubscribe = scope.subscribe(() => {
					this.publish();
				});
			}
			/** Resolve a field's spec. */
			spec(field) {
				const spec = this.specs.get(field);
				if (spec === undefined) throw new Error(`dsh-mail settings page has no field ${field}`);
				return spec;
			}
			/** The namespace section, base layer, and the user layer's presence set. */
			snapshot() {
				return this.scope.getSnapshot();
			}
			/** The effective value of one field. */
			effective(field) {
				return sectionValue(this.snapshot().value, this.spec(field).path);
			}
			/** The composition-layer value of one field, used by reset. */
			inherited(field) {
				return sectionValue(this.snapshot().base, this.spec(field).path);
			}
			/** Whether the user layer carries this field. */
			stored(field) {
				const user = this.snapshot().user;
				const parentPath = this.spec(field).path.slice(0, -1);
				const parent = parentPath.length === 0 ? user : sectionValue(user, parentPath);
				return parent !== undefined && parent !== null && Object.hasOwn(parent, this.spec(field).path.at(-1));
			}
			/** Parse one draft into a value the config accepts, or undefined when invalid. */
			parse(field, text) {
				const spec = this.spec(field);
				if (spec.text === true) {
					const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
					return { kind: "set", value: lines };
				}
				if (spec.number === true) {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					return Number.isFinite(parsed) ? { kind: "set", value: parsed } : undefined;
				}
				if (spec.flag === true) {
					const trimmed = text.trim().toLowerCase();
					if (trimmed === "true" || trimmed === "1" || trimmed === "yes") return { kind: "set", value: true };
					if (trimmed === "false" || trimmed === "0" || trimmed === "no") return { kind: "set", value: false };
					return undefined;
				}
				const trimmed = text.trim();
				return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
			}
			/** The text a control shows for one field. */
			text(field) {
				const staged = this.draft.get(field);
				if (staged !== undefined) return staged;
				const spec = this.spec(field);
				const value = this.effective(field);
				return spec.text === true ? formatList(value) : formatScalar(value);
			}
			/** One control's state. */
			fieldState(field) {
				const staged = this.draft.get(field);
				if (staged === undefined) {
					return {
						text: this.text(field),
						overridden: this.stored(field),
						invalid: false
					};
				}
				return {
					text: staged,
					overridden: this.parse(field, staged)?.kind === "set",
					invalid: this.parse(field, staged) === undefined
				};
			}
			/**
			* Every write a save would submit.
			* @returns the path operations, or undefined for a draft the config cannot accept.
			*/
			plan() {
				const ops = [];
				let invalid = false;
				for (const [field, text] of this.draft) {
					const spec = this.spec(field);
					const parsed = this.parse(field, text);
					if (parsed === undefined) {
						invalid = true;
						continue;
					}
					if (parsed.kind === "set") {
						ops.push({ op: "set", path: spec.path, value: parsed.value });
						continue;
					}
					// Clearing restores the inherited value; on a list that means removing the element.
					const inherited = this.inherited(field);
					if (spec.text === true) {
						ops.push({ op: "set", path: spec.path, value: Array.isArray(inherited) ? inherited : [] });
						continue;
					}
					ops.push({ op: "set", path: spec.path, value: inherited });
				}
				return invalid ? undefined : ops;
			}
			/** The form state every control shares. */
			shell() {
				const snapshot = this.snapshot();
				const ops = this.plan();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: this.draft.size > 0,
					invalid: ops === undefined,
					saving: this.saving,
					failed: this.failed
				};
			}
			/**
			* Build the projection the page's slot entry injects.
			*
			* The store is hand-rolled and keeps a *stable* snapshot reference: a selector hook in the
			* slot runtime re-renders when the value identity changes, so returning a freshly built
			* object on every read would re-render forever. The cached object is only replaced when the
			* projection actually differs, and only then are subscribers notified.
			*
			* @returns the store the component reads through its selector.
			*/
			bind() {
				const project = () => {
					const state = this.shell();
					for (const spec of SPECS) state[spec.field] = this.fieldState(spec.field);
					return state;
				};
				this.snapshotValue = project();
				this.store = {
					getSnapshot: () => this.snapshotValue,
					subscribe: (listener) => {
						this.listeners.add(listener);
						return () => {
							this.listeners.delete(listener);
						};
					}
				};
				return this.store;
			}
			/** Rebuild the projection and notify subscribers only when something changed. */
			publish() {
				const previous = this.snapshotValue;
				const next = this.projectCurrent();
				if (previous !== undefined && shallowEqual(previous, next)) return;
				this.snapshotValue = next;
				for (const listener of [...this.listeners]) listener();
			}
			/** Rebuild the projection without publishing it. */
			projectCurrent() {
				const state = this.shell();
				for (const spec of SPECS) state[spec.field] = this.fieldState(spec.field);
				return state;
			}
			/**
			* Write the staged edits.
			* @returns settlement.
			*/
			async save() {
				const ops = this.plan();
				if (ops === undefined || ops.length === 0 || this.saving || !this.snapshot().writable) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				try {
					const landed = await this.scope.mutate(ops, this.snapshot().revision);
					if (landed) this.draft.clear();
					this.failed = !landed;
				} catch (_error) {
					this.failed = true;
				} finally {
					this.saving = false;
					this.publish();
				}
			}
			/**
			* Build the face the page's slot entry injects.
			* @returns the snapshot hook and the form actions.
			*/
			inject() {
				return {
					hooks: { mailForm: this.store },
					edit: (field, text) => {
						this.draft.set(field, text);
						this.publish();
					},
					resetField: (field) => {
						const spec = this.spec(field);
						this.draft.set(field, spec.text === true ? formatList(this.inherited(field)) : formatScalar(this.inherited(field)));
						this.publish();
					},
					save: () => {
						void this.save();
					},
					discard: () => {
						if (this.draft.size === 0 && !this.failed) return;
						this.draft.clear();
						this.failed = false;
						this.publish();
					}
				};
			}
			/** Release the accepted-value subscription. */
			dispose() {
				this.unsubscribe();
				this.listeners.clear();
			}
		};
		//#endregion
		//#region plugin
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.dshMail";
		/** The Host profile entry id whose volatile fields this page edits. */
		const MAIL_NS = "dsh-mail";
		/** Required services. `configForms` keeps the providing fiber, so no remote is needed. */
		const inject = [
			"slots",
			"locale",
			"configForms"
		];
		/**
		* Mount the mail channel's settings page while the Host serves its namespace.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				en,
				zh
			}), "dsh-mail: dictionaries");
			const card = new MailFormController(ctx.configForms.get(MAIL_NS));
			card.store = card.bind();
			ctx.effect(() => () => {
				card.dispose();
			}, "dsh-mail: form subscription");
			ctx.effect(() => ctx.configForms.whileServed([MAIL_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id: MAIL_NS,
				order: 30,
				label: () => t("title"),
				locale: NS,
				inject: () => card.inject()
			}, MailCard))), "dsh-mail: page");
		}
		//#endregion
		exports.NS = NS;
		exports.MAIL_NS = MAIL_NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
