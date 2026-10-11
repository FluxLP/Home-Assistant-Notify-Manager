// Notify Manager panel – plain web component, no build step required.

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const clone = (o) => JSON.parse(JSON.stringify(o));

const PRIORITY_LABELS = { normal: "Normal", time_sensitive: "Zeitkritisch", critical: "Kritisch" };

const ACTION_PRESETS = {
  confirm: { key: "bestaetigt", title: "Bestätigen", destructive: false, text_input: false },
  decline: { key: "abgelehnt", title: "Ablehnen", destructive: true, text_input: false },
  later: { key: "spaeter", title: "Später erinnern", destructive: false, text_input: false },
  reply: { key: "antwort", title: "Antworten", destructive: false, text_input: true },
  custom: { key: "", title: "", destructive: false, text_input: false },
};

const NEW_TEMPLATE = () => ({
  id: "",
  name: "",
  icon: "mdi:bell",
  description: "",
  title: "",
  message: "",
  tts_message: "",
  variables: [],
  recipients: [],
  push_devices: [],
  priority: "normal",
  critical_volume: 1,
  actions: [],
  wait: false,
  timeout: 300,
  clear_on_response: true,
  url: "",
  image: "",
  group: "",
  alexa: { entities: [], mode: "announce" },
  music_assistant: { entities: [], volume: null },
  tts: { engine: "", entities: [] },
  persistent: false,
  quiet_hours: { enabled: false, start: "22:00", end: "07:00" },
  speakers_only_when_home: false,
});

const NEW_RECIPIENT = () => ({ id: "", name: "", person: "", push_devices: [] });

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const setPath = (obj, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
};

class NotifyManagerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "templates";
    this._edit = null;
    this._config = null;
    this._targets = null;
    this._log = [];
    this._toast = null;
    this._unsubEvents = [];
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("input", (ev) => this._onInput(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onInput(ev));
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
  }

  set narrow(narrow) {
    if (this._narrow === narrow) return;
    this._narrow = narrow;
    if (this._config) this._render();
  }

  set panel(_panel) {}

  connectedCallback() {
    if (this._hass && !this._unsubEvents.length) this._subscribe();
  }

  disconnectedCallback() {
    this._unsubEvents.forEach((p) => p.then((unsub) => unsub()).catch(() => {}));
    this._unsubEvents = [];
  }

  async _load() {
    try {
      const [config, targets] = await Promise.all([
        this._hass.callWS({ type: "notify_manager/config" }),
        this._hass.callWS({ type: "notify_manager/targets" }),
      ]);
      this._config = config;
      this._targets = targets;
    } catch (err) {
      this._error = err.message || String(err);
    }
    this._subscribe();
    this._render();
  }

  _subscribe() {
    if (this._unsubEvents.length || !this._hass) return;
    const refresh = () => {
      if (this._tab === "log") this._loadLog();
    };
    for (const type of ["notify_manager_sent", "notify_manager_response"]) {
      this._unsubEvents.push(this._hass.connection.subscribeEvents(refresh, type));
    }
  }

  async _loadLog() {
    const { log } = await this._hass.callWS({ type: "notify_manager/log" });
    this._log = log;
    this._render();
  }

  _notify(message, error = false) {
    this._toast = { message, error };
    this._render();
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast = null;
      this._render();
    }, 4000);
  }

  // ------------------------------------------------------------------ events

  async _onClick(ev) {
    const el = ev.target.closest("[data-cmd]");
    if (!el) return;
    const { cmd, arg } = el.dataset;
    switch (cmd) {
      case "menu":
        this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
        return;
      case "tab":
        this._tab = arg;
        this._edit = null;
        if (arg === "log") return this._loadLog();
        if (arg === "devices") {
          this._targets = await this._hass.callWS({ type: "notify_manager/targets" });
        }
        break;
      case "new-template":
        this._edit = { kind: "template", data: NEW_TEMPLATE() };
        break;
      case "edit-template":
        this._edit = { kind: "template", data: { ...NEW_TEMPLATE(), ...clone(this._config.templates.find((t) => t.id === arg)) } };
        break;
      case "new-recipient":
        this._edit = { kind: "recipient", data: NEW_RECIPIENT() };
        break;
      case "edit-recipient":
        this._edit = { kind: "recipient", data: clone(this._config.recipients.find((r) => r.id === arg)) };
        break;
      case "cancel":
        this._edit = null;
        break;
      case "save":
        await this._save();
        return;
      case "delete":
        await this._delete();
        return;
      case "test":
        await this._test();
        return;
      case "add-action":
        this._edit.data.actions.push({ ...ACTION_PRESETS[arg] });
        if (arg !== "custom" && !this._edit.data.wait && this._edit.data.actions.length === 1) this._edit.data.wait = true;
        break;
      case "remove-action":
        this._edit.data.actions.splice(Number(arg), 1);
        break;
      case "copy":
        await navigator.clipboard.writeText(this.shadowRoot.getElementById(arg).textContent);
        this._notify("In die Zwischenablage kopiert");
        return;
      case "refresh-log":
        return this._loadLog();
      default:
        return;
    }
    this._render();
  }

  _onInput(ev) {
    const el = ev.target;
    if (!this._edit) return;
    const data = this._edit.data;

    if (el.dataset.list) {
      const list = getPath(data, el.dataset.list) || [];
      const next = el.checked ? [...new Set([...list, el.value])] : list.filter((v) => v !== el.value);
      setPath(data, el.dataset.list, next);
      if (el.dataset.rerender !== undefined) this._render();
      return;
    }
    if (el.dataset.actionIdx !== undefined) {
      const action = data.actions[Number(el.dataset.actionIdx)];
      action[el.dataset.field] = el.type === "checkbox" ? el.checked : el.value;
      if (el.dataset.field === "title" && !action._keyTouched && ev.type === "input") {
        action.key = this._slug(el.value);
        const keyInput = this.shadowRoot.querySelector(`input[data-action-idx="${el.dataset.actionIdx}"][data-field="key"]`);
        if (keyInput) keyInput.value = action.key;
      }
      if (el.dataset.field === "key") action._keyTouched = true;
      this._updateUsage();
      return;
    }
    const path = el.dataset.path;
    if (!path) return;
    let value;
    if (el.type === "checkbox") value = el.checked;
    else if (el.type === "number" || el.type === "range") value = el.value === "" ? null : Number(el.value);
    else if (path === "variables") value = el.value.split(",").map((v) => v.trim());
    else value = el.value;
    setPath(data, path, value);

    if (el.dataset.rerender !== undefined && ev.type === "change") this._render();
    else if (el.type === "range") {
      const out = this.shadowRoot.querySelector(`[data-out="${path}"]`);
      if (out) out.textContent = el.dataset.percent !== undefined ? `${Math.round(value * 100)} %` : `${value} %`;
    }
    if (["variables", "name", "wait"].includes(path)) this._updateUsage();
  }

  _slug(text) {
    return String(text)
      .toLowerCase()
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  _cleanTemplate(data) {
    const tpl = clone(data);
    tpl.timeout = tpl.timeout ?? 0;
    tpl.variables = (tpl.variables || []).map((v) => this._slug(v)).filter(Boolean);
    tpl.actions = tpl.actions
      .filter((a) => a.title.trim())
      .map(({ _keyTouched, ...a }) => ({ ...a, key: this._slug(a.key || a.title) }));
    return tpl;
  }

  async _save() {
    const { kind, data } = this._edit;
    if (!data.name?.trim()) return this._notify("Bitte einen Namen eingeben", true);
    try {
      if (kind === "template") {
        const { template } = await this._hass.callWS({ type: "notify_manager/template/save", template: this._cleanTemplate(data) });
        this._edit.data = { ...NEW_TEMPLATE(), ...template };
      } else {
        const { recipient } = await this._hass.callWS({ type: "notify_manager/recipient/save", recipient: data });
        this._edit.data = recipient;
      }
      this._config = await this._hass.callWS({ type: "notify_manager/config" });
      this._notify("Gespeichert");
      return true;
    } catch (err) {
      this._notify(`Fehler: ${err.message || err}`, true);
      return false;
    }
  }

  async _delete() {
    const { kind, data } = this._edit;
    if (!data.id) {
      this._edit = null;
      return this._render();
    }
    if (!confirm(`„${data.name}“ wirklich löschen?`)) return;
    await this._hass.callWS(
      kind === "template"
        ? { type: "notify_manager/template/delete", template_id: data.id }
        : { type: "notify_manager/recipient/delete", recipient_id: data.id }
    );
    this._config = await this._hass.callWS({ type: "notify_manager/config" });
    this._edit = null;
    this._notify("Gelöscht");
  }

  async _test() {
    if (!(await this._save())) return;
    const tpl = this._edit.data;
    const variables = Object.fromEntries(tpl.variables.map((v) => [v, `[${v}]`]));
    try {
      const res = await this._hass.callWS({ type: "notify_manager/test", template_id: tpl.id, variables });
      if (res.errors?.length) this._notify(`Gesendet mit Fehlern: ${res.errors.join("; ")}`, true);
      else this._notify("Testnachricht gesendet");
    } catch (err) {
      this._notify(`Fehler: ${err.message || err}`, true);
    }
  }

  // ------------------------------------------------------------------ render helpers

  _check(path, label, checked, attrs = "") {
    return `<label class="check"><input type="checkbox" data-path="${path}" ${checked ? "checked" : ""} ${attrs}><span>${label}</span></label>`;
  }

  _listChecks(listPath, items, selected, valueKey, empty) {
    if (!items.length) return `<p class="hint">${empty}</p>`;
    return `<div class="chips">${items
      .map((item) => {
        const value = item[valueKey];
        const on = selected.includes(value);
        const off = item.available === false ? " unavailable" : "";
        return `<label class="chip${on ? " on" : ""}${off}" title="${esc(value)}">
          <input type="checkbox" data-list="${listPath}" data-rerender value="${esc(value)}" ${on ? "checked" : ""}>
          ${esc(item.name)}${item.available === false ? ' <small>(offline)</small>' : ""}</label>`;
      })
      .join("")}</div>`;
  }

  _field(label, inner, hint = "") {
    return `<label class="field"><span class="label">${label}</span>${inner}${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
  }

  _text(path, value, attrs = "") {
    return `<input type="text" data-path="${path}" value="${esc(value)}" ${attrs}>`;
  }

  _section(icon, title, body, subtitle = "") {
    return `<section class="card"><h2><ha-icon icon="${icon}"></ha-icon>${title}${subtitle ? `<small>${subtitle}</small>` : ""}</h2>${body}</section>`;
  }

  // ------------------------------------------------------------------ views

  _render() {
    const narrow = this._narrow;
    const tabs = [
      ["templates", "mdi:file-document-multiple-outline", "Vorlagen"],
      ["recipients", "mdi:account-multiple", "Empfänger"],
      ["devices", "mdi:devices", "Geräte"],
      ["log", "mdi:history", "Verlauf"],
    ];
    let body;
    if (this._error) body = `<div class="card error">Fehler beim Laden: ${esc(this._error)}</div>`;
    else if (!this._config) body = `<div class="loading">Lädt …</div>`;
    else if (this._edit?.kind === "template") body = this._renderTemplateEditor();
    else if (this._edit?.kind === "recipient") body = this._renderRecipientEditor();
    else body = { templates: () => this._renderTemplates(), recipients: () => this._renderRecipients(), devices: () => this._renderDevices(), log: () => this._renderLog() }[this._tab]();

    const scroll = this.shadowRoot.querySelector(".content")?.scrollTop ?? 0;
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="toolbar">
        ${narrow ? `<button class="icon-btn" data-cmd="menu" aria-label="Menü"><ha-icon icon="mdi:menu"></ha-icon></button>` : ""}
        <div class="title">Notify Manager</div>
      </div>
      <nav class="tabs">${tabs
        .map(([id, icon, label]) => `<button class="tab${this._tab === id ? " active" : ""}" data-cmd="tab" data-arg="${id}"><ha-icon icon="${icon}"></ha-icon><span>${label}</span></button>`)
        .join("")}</nav>
      <div class="content"><div class="inner">${body}</div></div>
      ${this._toast ? `<div class="toast${this._toast.error ? " error" : ""}">${esc(this._toast.message)}</div>` : ""}
    `;
    if (this._edit) this.shadowRoot.querySelector(".content").scrollTop = scroll;
  }

  _renderTemplates() {
    const templates = this._config.templates;
    const cards = templates
      .map((t) => {
        const pushCount = new Set([...t.push_devices, ...t.recipients.flatMap((id) => this._config.recipients.find((r) => r.id === id)?.push_devices || [])]).size;
        const speakers = t.alexa.entities.length + t.music_assistant.entities.length + t.tts.entities.length;
        const badges = [
          pushCount ? `<span class="badge"><ha-icon icon="mdi:cellphone"></ha-icon>${pushCount}</span>` : "",
          speakers ? `<span class="badge"><ha-icon icon="mdi:speaker"></ha-icon>${speakers}</span>` : "",
          t.priority !== "normal" ? `<span class="badge ${t.priority}">${PRIORITY_LABELS[t.priority]}</span>` : "",
          t.actions.length ? `<span class="badge"><ha-icon icon="mdi:gesture-tap-button"></ha-icon>${t.actions.map((a) => esc(a.title)).join(" · ")}</span>` : "",
        ].join("");
        return `<button class="item" data-cmd="edit-template" data-arg="${t.id}">
          <ha-icon class="item-icon" icon="${esc(t.icon || "mdi:bell")}"></ha-icon>
          <div class="item-main"><div class="item-title">${esc(t.name)}</div>
          <div class="item-sub">notify_manager.${esc(t.service)}</div><div class="badges">${badges}</div></div>
          <ha-icon icon="mdi:chevron-right"></ha-icon></button>`;
      })
      .join("");
    return `
      <div class="head"><h1>Benachrichtigungs-Vorlagen</h1>
        <button class="btn primary" data-cmd="new-template"><ha-icon icon="mdi:plus"></ha-icon>Neue Vorlage</button></div>
      ${templates.length ? `<div class="list">${cards}</div>` : `<div class="empty card"><ha-icon icon="mdi:bell-plus-outline"></ha-icon><p>Noch keine Vorlagen. Lege eine an und verwende sie danach in Automationen als Aktion <code>notify_manager.&lt;name&gt;</code>.</p></div>`}`;
  }

  _renderTemplateEditor() {
    const t = this._edit.data;
    const tg = this._targets;
    const recipients = this._config.recipients;
    const isNew = !t.id;

    const general = this._section(
      "mdi:information-outline",
      "Allgemein",
      `<div class="grid">
        ${this._field("Name", this._text("name", t.name, 'placeholder="z.B. Waschmaschine fertig"'))}
        ${this._field("Icon", this._text("icon", t.icon, 'placeholder="mdi:bell"'))}
      </div>
      ${this._field("Beschreibung", this._text("description", t.description, 'placeholder="Optional – erscheint im Aktions-Dialog der Automation"'))}
      ${this._field("Variablen", this._text("variables", t.variables.join(", "), 'placeholder="geraet, dauer"'), "Kommagetrennt. Im Text als <code>{{ geraet }}</code> verwendbar, in der Automation als eigene Felder.")}`
    );

    const content = this._section(
      "mdi:text",
      "Inhalt",
      `${this._field("Titel", this._text("title", t.title, 'placeholder="{{ geraet }} ist fertig"'))}
      ${this._field("Text", `<textarea data-path="message" rows="3" placeholder="Die {{ geraet }} ist nach {{ dauer }} Minuten fertig.">${esc(t.message)}</textarea>`, "Jinja-Templates erlaubt, z.B. <code>{{ states('sensor.temperatur') }}</code>.")}
      ${this._field("Ansagetext für Lautsprecher", `<textarea data-path="tts_message" rows="2" placeholder="Leer = gleicher Text wie oben">${esc(t.tts_message)}</textarea>`)}`
    );

    const priorities = Object.entries(PRIORITY_LABELS)
      .map(([value, label]) => `<label class="seg${t.priority === value ? " on" : ""} ${value}"><input type="radio" name="priority" data-path="priority" data-rerender value="${value}" ${t.priority === value ? "checked" : ""}>${label}</label>`)
      .join("");
    const push = this._section(
      "mdi:cellphone-message",
      "Handy-Benachrichtigung",
      `<div class="label">Empfänger</div>
      ${this._listChecks("recipients", recipients, t.recipients, "id", 'Noch keine Empfänger angelegt – siehe Reiter „Empfänger“.')}
      <div class="label">Zusätzliche Geräte</div>
      ${this._listChecks("push_devices", tg.push, t.push_devices, "service", "Keine Geräte mit der Home-Assistant-App gefunden.")}
      <div class="label">Priorität</div>
      <div class="segmented">${priorities}</div>
      <p class="hint">${{
        normal: "Normale Mitteilung.",
        time_sensitive: "Durchbricht Fokus-Modi (iOS) bzw. wird mit hoher Priorität zugestellt (Android).",
        critical: "Kommt auch bei „Nicht stören“ und Stummschaltung mit Ton durch. Auf iOS muss „Kritische Hinweise“ für die App erlaubt sein.",
      }[t.priority]}</p>
      ${t.priority === "critical" ? this._field("Lautstärke (iOS)", `<div class="range"><input type="range" min="0" max="1" step="0.05" data-path="critical_volume" data-percent value="${t.critical_volume}"><output data-out="critical_volume">${Math.round(t.critical_volume * 100)} %</output></div>`) : ""}
      <details><summary>Erweitert</summary>
        <div class="grid">
          ${this._field("Link beim Antippen", this._text("url", t.url, 'placeholder="/lovelace/0 oder https://…"'))}
          ${this._field("Bild-URL", this._text("image", t.image, 'placeholder="/api/camera_proxy/camera.haustuer"'))}
          ${this._field("Gruppe", this._text("group", t.group, 'placeholder="z.B. haushalt"'), "Gleiche Gruppen werden zusammengefasst.")}
        </div>
      </details>`
    );

    const actionRows = t.actions
      .map(
        (a, i) => `<div class="action-row">
          <input type="text" data-action-idx="${i}" data-field="title" value="${esc(a.title)}" placeholder="Button-Text">
          <input type="text" class="mono" data-action-idx="${i}" data-field="key" value="${esc(a.key)}" placeholder="schluessel">
          <label class="check small"><input type="checkbox" data-action-idx="${i}" data-field="destructive" ${a.destructive ? "checked" : ""}><span>rot</span></label>
          <label class="check small"><input type="checkbox" data-action-idx="${i}" data-field="text_input" ${a.text_input ? "checked" : ""}><span>Texteingabe</span></label>
          <button class="icon-btn" data-cmd="remove-action" data-arg="${i}" aria-label="Entfernen"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
        </div>`
      )
      .join("");
    const actions = this._section(
      "mdi:gesture-tap-button",
      "Aktionen",
      `<p class="hint">Buttons in der Handy-Benachrichtigung. Der Schlüssel ist die Antwort, mit der deine Automation weiterarbeitet.</p>
      ${actionRows ? `<div class="actions">${actionRows}</div>` : ""}
      <div class="preset-row">
        <button class="btn" data-cmd="add-action" data-arg="confirm"><ha-icon icon="mdi:check"></ha-icon>Bestätigen</button>
        <button class="btn" data-cmd="add-action" data-arg="decline"><ha-icon icon="mdi:close"></ha-icon>Ablehnen</button>
        <button class="btn" data-cmd="add-action" data-arg="later"><ha-icon icon="mdi:clock-outline"></ha-icon>Später</button>
        <button class="btn" data-cmd="add-action" data-arg="reply"><ha-icon icon="mdi:reply"></ha-icon>Antworten</button>
        <button class="btn" data-cmd="add-action" data-arg="custom"><ha-icon icon="mdi:plus"></ha-icon>Eigene</button>
      </div>
      ${t.actions.length ? `<div class="grid">
        ${this._check("wait", "Automation wartet auf Antwort", t.wait, "data-rerender")}
        ${this._check("clear_on_response", "Nach Antwort auf allen Geräten entfernen", t.clear_on_response)}
      </div>
      ${this._field("Zeitlimit (Sekunden)", `<input type="number" min="0" data-path="timeout" value="${t.timeout}">`, "Danach lautet die Antwort <code>timeout</code>. 0 = kein Limit.")}` : ""}`
    );

    const engines = tg.tts_engines.map((e) => `<option value="${esc(e.entity_id)}" ${t.tts.engine === e.entity_id ? "selected" : ""}>${esc(e.name)}</option>`).join("");
    const speakers = this._section(
      "mdi:speaker-message",
      "Lautsprecher-Ansage",
      `${tg.alexa.length ? `<div class="label">Amazon Echo (Alexa Media)</div>
        ${this._listChecks("alexa.entities", tg.alexa, t.alexa.entities, "entity_id", "")}
        <div class="segmented small">
          <label class="seg${t.alexa.mode === "announce" ? " on" : ""}"><input type="radio" name="alexa_mode" data-path="alexa.mode" data-rerender value="announce" ${t.alexa.mode === "announce" ? "checked" : ""}>Ansage mit Gong</label>
          <label class="seg${t.alexa.mode === "tts" ? " on" : ""}"><input type="radio" name="alexa_mode" data-path="alexa.mode" data-rerender value="tts" ${t.alexa.mode === "tts" ? "checked" : ""}>Nur sprechen (TTS)</label>
        </div>` : ""}
      ${tg.music_assistant.length ? `<div class="label">Music Assistant</div>
        ${this._listChecks("music_assistant.entities", tg.music_assistant, t.music_assistant.entities, "entity_id", "")}
        ${this._field("Ansage-Lautstärke (%)", `<input type="number" min="0" max="100" data-path="music_assistant.volume" value="${t.music_assistant.volume ?? ""}" placeholder="Standard">`)}` : ""}
      ${tg.media_players.length ? `<details ${t.tts.entities.length ? "open" : ""}><summary>Weitere Media Player (TTS)</summary>
        ${this._listChecks("tts.entities", tg.media_players, t.tts.entities, "entity_id", "")}</details>` : ""}
      ${this._field("Sprachausgabe (TTS)", `<select data-path="tts.engine"><option value="">Automatisch (Home Assistant Cloud)</option>${engines}</select>`, "Für Music Assistant und weitere Media Player.")}
      <div class="label">Bedingungen</div>
      ${this._check("speakers_only_when_home", "Nur ansagen, wenn jemand zu Hause ist", t.speakers_only_when_home)}
      ${this._check("quiet_hours.enabled", "Ruhezeit – dann keine Ansagen", t.quiet_hours.enabled, "data-rerender")}
      ${t.quiet_hours.enabled ? `<div class="grid">
        ${this._field("Von", `<input type="time" data-path="quiet_hours.start" value="${t.quiet_hours.start}">`)}
        ${this._field("Bis", `<input type="time" data-path="quiet_hours.end" value="${t.quiet_hours.end}">`)}
      </div>` : ""}`
    );

    const other = this._section(
      "mdi:bell-outline",
      "Home Assistant",
      this._check("persistent", "Zusätzlich als Benachrichtigung in Home Assistant anzeigen", t.persistent)
    );

    return `
      <div class="head">
        <button class="icon-btn" data-cmd="cancel" aria-label="Zurück"><ha-icon icon="mdi:arrow-left"></ha-icon></button>
        <h1>${isNew ? "Neue Vorlage" : esc(t.name)}</h1>
        <div class="spacer"></div>
        ${isNew ? "" : `<button class="btn danger" data-cmd="delete"><ha-icon icon="mdi:delete-outline"></ha-icon>Löschen</button>`}
        <button class="btn" data-cmd="test"><ha-icon icon="mdi:send-outline"></ha-icon>Testen</button>
        <button class="btn primary" data-cmd="save"><ha-icon icon="mdi:content-save-outline"></ha-icon>Speichern</button>
      </div>
      ${general}${content}${push}${actions}${speakers}${other}
      <div id="usage">${this._renderUsage(t)}</div>`;
  }

  _usageYaml(t) {
    const service = t.service || this._slug(t.name) || "meine_vorlage";
    const vars = (t.variables || []).map((v) => this._slug(v)).filter(Boolean);
    const lines = [`action: notify_manager.${service}`];
    if (vars.length || (t.actions.length && t.wait)) lines.push("data:");
    vars.forEach((v) => lines.push(`  ${v}: "…"`));
    if (t.actions.length && t.wait) lines.push("response_variable: antwort");
    let yaml = lines.join("\n");
    if (t.actions.length && t.wait) {
      const keys = t.actions.map((a) => this._slug(a.key || a.title)).filter(Boolean);
      yaml += `\n\n# danach z.B.:\n- choose:\n${keys
        .map((k) => `    - conditions: "{{ antwort.response == '${k}' }}"\n      sequence: []`)
        .join("\n")}\n  default: []  # timeout`;
    }
    return yaml;
  }

  _renderUsage(t) {
    const eventYaml = `trigger: event\nevent_type: notify_manager_response\nevent_data:\n  template: ${t.name || "…"}\n  response: ${this._slug(t.actions[0]?.key || t.actions[0]?.title || "bestaetigt")}`;
    return this._section(
      "mdi:robot-outline",
      "In Automationen verwenden",
      `<p class="hint">Als Aktion (erscheint auch in der Aktionsauswahl unter „Notify Manager“):</p>
      <div class="code-wrap"><pre id="yaml-action">${esc(this._usageYaml(t))}</pre><button class="icon-btn" data-cmd="copy" data-arg="yaml-action" aria-label="Kopieren"><ha-icon icon="mdi:content-copy"></ha-icon></button></div>
      ${t.actions.length ? `<p class="hint">Oder in einer eigenen Automation auf die Antwort reagieren:</p>
      <div class="code-wrap"><pre id="yaml-event">${esc(eventYaml)}</pre><button class="icon-btn" data-cmd="copy" data-arg="yaml-event" aria-label="Kopieren"><ha-icon icon="mdi:content-copy"></ha-icon></button></div>` : ""}`
    );
  }

  _updateUsage() {
    const el = this.shadowRoot.getElementById("usage");
    if (el && this._edit?.kind === "template") el.innerHTML = this._renderUsage(this._edit.data);
  }

  _renderRecipients() {
    const recipients = this._config.recipients;
    const pushName = (s) => this._targets.push.find((p) => p.service === s)?.name || s;
    const cards = recipients
      .map((r) => {
        const person = r.person ? this._hass.states[r.person] : null;
        return `<button class="item" data-cmd="edit-recipient" data-arg="${r.id}">
          <ha-icon class="item-icon" icon="mdi:account"></ha-icon>
          <div class="item-main"><div class="item-title">${esc(r.name)}</div>
          <div class="item-sub">${person ? `${esc(person.attributes.friendly_name)} · ${esc(this._hass.formatEntityState ? this._hass.formatEntityState(person) : person.state)}` : "keine Person verknüpft"}</div>
          <div class="badges">${r.push_devices.map((s) => `<span class="badge"><ha-icon icon="mdi:cellphone"></ha-icon>${esc(pushName(s))}</span>`).join("")}</div></div>
          <ha-icon icon="mdi:chevron-right"></ha-icon></button>`;
      })
      .join("");
    return `
      <div class="head"><h1>Empfänger</h1>
        <button class="btn primary" data-cmd="new-recipient"><ha-icon icon="mdi:plus"></ha-icon>Neuer Empfänger</button></div>
      ${recipients.length ? `<div class="list">${cards}</div>` : `<div class="empty card"><ha-icon icon="mdi:account-plus-outline"></ha-icon><p>Fasse die Geräte einer Person zu einem Empfänger zusammen, z.B. „Felix“ = iPhone + iPad.</p></div>`}`;
  }

  _renderRecipientEditor() {
    const r = this._edit.data;
    const persons = this._targets.persons.map((p) => `<option value="${esc(p.entity_id)}" ${r.person === p.entity_id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    return `
      <div class="head">
        <button class="icon-btn" data-cmd="cancel" aria-label="Zurück"><ha-icon icon="mdi:arrow-left"></ha-icon></button>
        <h1>${r.id ? esc(r.name) : "Neuer Empfänger"}</h1>
        <div class="spacer"></div>
        ${r.id ? `<button class="btn danger" data-cmd="delete"><ha-icon icon="mdi:delete-outline"></ha-icon>Löschen</button>` : ""}
        <button class="btn primary" data-cmd="save"><ha-icon icon="mdi:content-save-outline"></ha-icon>Speichern</button>
      </div>
      ${this._section(
        "mdi:account",
        "Empfänger",
        `<div class="grid">
          ${this._field("Name", this._text("name", r.name, 'placeholder="z.B. Felix"'))}
          ${this._field("Person", `<select data-path="person"><option value="">–</option>${persons}</select>`)}
        </div>
        <div class="label">Geräte</div>
        ${this._listChecks("push_devices", this._targets.push, r.push_devices, "service", "Keine Geräte mit der Home-Assistant-App gefunden.")}`
      )}`;
  }

  _renderDevices() {
    const tg = this._targets;
    const rows = (items, key, icon) =>
      items.length
        ? `<div class="device-list">${items
            .map((i) => `<div class="device"><ha-icon icon="${icon}"></ha-icon><div><div>${esc(i.name)}</div><div class="item-sub mono">${esc(i[key])}</div></div><span class="dot ${i.available === false ? "off" : "on"}"></span></div>`)
            .join("")}</div>`
        : `<p class="hint">Keine gefunden.</p>`;
    return `
      <div class="head"><h1>Gefundene Geräte</h1></div>
      ${this._section("mdi:cellphone", "Handys & Tablets", rows(tg.push.map((p) => ({ ...p, service: `notify.${p.service}` })), "service", "mdi:cellphone"), "Home Assistant App")}
      ${this._section("mdi:amazon-alexa", "Amazon Echo", rows(tg.alexa, "entity_id", "mdi:speaker"), "Alexa Media Player")}
      ${this._section("mdi:music", "Music Assistant", rows(tg.music_assistant, "entity_id", "mdi:speaker-wireless"), "Ansagen mit Gong")}
      ${this._section("mdi:cast", "Weitere Media Player", rows(tg.media_players, "entity_id", "mdi:cast-audio"), "per TTS")}
      ${this._section("mdi:account-voice", "Sprachausgabe", rows(tg.tts_engines, "entity_id", "mdi:account-voice"))}`;
  }

  _renderLog() {
    const statusLabel = (e) => {
      if (e.status === "sent") return `<span class="badge">gesendet</span>`;
      if (e.status === "waiting") return `<span class="badge time_sensitive">wartet</span>`;
      if (e.status === "timeout") return `<span class="badge">keine Antwort</span>`;
      const r = e.response || {};
      return `<span class="badge ok">${esc(r.response_title || e.status)}${r.device ? ` · ${esc(r.device)}` : ""}</span>${r.reply_text ? ` „${esc(r.reply_text)}“` : ""}`;
    };
    const rows = this._log
      .map((e) => {
        const time = new Date(e.time).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium" });
        const targets = Object.entries(e.targets || {}).map(([k, v]) => `${k}: ${v.length}`).join(", ");
        return `<div class="log-row card">
          <div class="log-head"><strong>${esc(e.template)}</strong>${e.test ? ' <span class="badge">Test</span>' : ""}<span class="spacer"></span><small>${time}</small></div>
          <div>${e.title ? `<strong>${esc(e.title)}</strong> – ` : ""}${esc(e.message)}</div>
          <div class="log-meta">${statusLabel(e)} <small>${esc(targets)}</small>${e.skipped_speakers ? ` <small>· Ansage übersprungen (${esc(e.skipped_speakers)})</small>` : ""}</div>
          ${e.errors?.length ? `<div class="err">${e.errors.map(esc).join("<br>")}</div>` : ""}
        </div>`;
      })
      .join("");
    return `
      <div class="head"><h1>Verlauf</h1><div class="spacer"></div>
        <button class="btn" data-cmd="refresh-log"><ha-icon icon="mdi:refresh"></ha-icon>Aktualisieren</button></div>
      ${rows || `<div class="empty card"><ha-icon icon="mdi:history"></ha-icon><p>Seit dem letzten Neustart wurde nichts gesendet.</p></div>`}`;
  }
}

const STYLES = `
  :host { display: flex; flex-direction: column; height: 100%; background: var(--primary-background-color); color: var(--primary-text-color); font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
  * { box-sizing: border-box; }
  .toolbar { display: flex; align-items: center; height: var(--header-height, 56px); padding: 0 12px; background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff); border-bottom: var(--app-header-border-bottom, none); flex-shrink: 0; }
  .toolbar .title { font-size: 20px; font-weight: 400; margin-left: 12px; }
  .tabs { display: flex; gap: 4px; padding: 0 12px; background: var(--app-header-background-color, var(--primary-color)); overflow-x: auto; flex-shrink: 0; }
  .tab { display: flex; align-items: center; gap: 6px; padding: 10px 14px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--app-header-text-color, #fff); opacity: .75; cursor: pointer; font: inherit; font-size: 14px; white-space: nowrap; }
  .tab.active { opacity: 1; border-bottom-color: var(--app-header-text-color, #fff); }
  .tab ha-icon { --mdc-icon-size: 20px; }
  .content { flex: 1; overflow-y: auto; }
  .inner { max-width: 960px; margin: 0 auto; padding: 16px; }
  .head { display: flex; align-items: center; gap: 8px; margin: 4px 0 16px; flex-wrap: wrap; }
  .head h1 { font-size: 22px; font-weight: 400; margin: 0; flex: 1; min-width: 0; }
  .spacer { flex: 1; }
  .head h1 + .spacer { display: none; }
  .card { background: var(--card-background-color); border-radius: var(--ha-card-border-radius, 12px); border: 1px solid var(--divider-color); padding: 16px; margin-bottom: 16px; }
  .card h2 { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 500; margin: 0 0 12px; }
  .card h2 small { color: var(--secondary-text-color); font-weight: 400; font-size: 13px; margin-left: auto; }
  .card h2 ha-icon { color: var(--primary-color); }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 18px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); font: inherit; font-size: 14px; cursor: pointer; }
  .btn ha-icon { --mdc-icon-size: 18px; }
  .btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .btn.danger { color: var(--error-color); }
  .btn:hover { filter: brightness(.95); }
  .icon-btn { background: none; border: none; color: inherit; cursor: pointer; padding: 8px; border-radius: 50%; display: inline-flex; }
  .icon-btn:hover { background: rgba(127,127,127,.15); }
  .list { display: flex; flex-direction: column; gap: 8px; }
  .item { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; padding: 14px 16px; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: var(--ha-card-border-radius, 12px); color: inherit; font: inherit; cursor: pointer; }
  .item:hover { border-color: var(--primary-color); }
  .item-icon { color: var(--primary-color); --mdc-icon-size: 28px; }
  .item-main { flex: 1; min-width: 0; }
  .item-title { font-size: 16px; }
  .item-sub { font-size: 12px; color: var(--secondary-text-color); font-family: var(--code-font-family, monospace); }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 2px 8px; border-radius: 10px; background: rgba(127,127,127,.15); }
  .badge ha-icon { --mdc-icon-size: 14px; }
  .badge.time_sensitive { background: rgba(255,152,0,.2); }
  .badge.critical { background: rgba(244,67,54,.2); color: var(--error-color); }
  .badge.ok { background: rgba(76,175,80,.2); }
  .empty { text-align: center; color: var(--secondary-text-color); padding: 32px 16px; }
  .empty ha-icon { --mdc-icon-size: 48px; color: var(--primary-color); opacity: .6; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .label { font-size: 13px; color: var(--secondary-text-color); margin: 12px 0 6px; font-weight: 500; }
  .field .label { margin: 0; }
  .hint { font-size: 12px; color: var(--secondary-text-color); margin: 4px 0 8px; }
  code, .mono { font-family: var(--code-font-family, monospace); }
  input[type=text], input[type=number], input[type=time], textarea, select { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent); color: var(--primary-text-color); font: inherit; font-size: 14px; }
  input:focus, textarea:focus, select:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
  textarea { resize: vertical; }
  .check { display: flex; align-items: center; gap: 8px; margin: 6px 0; cursor: pointer; font-size: 14px; }
  .check input { width: 18px; height: 18px; accent-color: var(--primary-color); }
  .check.small { font-size: 12px; margin: 0; white-space: nowrap; }
  .check.small input { width: 16px; height: 16px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 16px; border: 1px solid var(--divider-color); cursor: pointer; font-size: 14px; user-select: none; }
  .chip input { display: none; }
  .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .chip.unavailable:not(.on) { opacity: .55; }
  .segmented { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 18px; overflow: hidden; margin: 4px 0; flex-wrap: wrap; }
  .seg { padding: 7px 14px; cursor: pointer; font-size: 14px; }
  .seg input { display: none; }
  .seg.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .seg.on.time_sensitive { background: var(--warning-color, #ff9800); }
  .seg.on.critical { background: var(--error-color); }
  .segmented.small .seg { font-size: 13px; padding: 5px 12px; }
  .range { display: flex; align-items: center; gap: 12px; }
  .range input { flex: 1; accent-color: var(--primary-color); }
  details { margin-top: 12px; }
  summary { cursor: pointer; color: var(--secondary-text-color); font-size: 14px; margin-bottom: 8px; }
  .actions { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .action-row { display: grid; grid-template-columns: 1fr 1fr auto auto auto; gap: 8px; align-items: center; }
  .preset-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .code-wrap { position: relative; }
  .code-wrap .icon-btn { position: absolute; top: 4px; right: 4px; }
  pre { background: var(--secondary-background-color, rgba(127,127,127,.1)); border-radius: 8px; padding: 12px 40px 12px 12px; margin: 0 0 12px; overflow-x: auto; font-size: 13px; font-family: var(--code-font-family, monospace); }
  .device-list { display: flex; flex-direction: column; }
  .device { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--divider-color); }
  .device:last-child { border-bottom: none; }
  .device > div { flex: 1; min-width: 0; }
  .device ha-icon { color: var(--secondary-text-color); }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .dot.on { background: var(--success-color, #4caf50); }
  .dot.off { background: var(--disabled-text-color, #999); }
  .log-row { padding: 12px 16px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
  .log-head { display: flex; align-items: center; gap: 8px; }
  .log-head small, .log-meta small { color: var(--secondary-text-color); }
  .err { color: var(--error-color); font-size: 12px; }
  .error { color: var(--error-color); }
  .loading { padding: 32px; text-align: center; color: var(--secondary-text-color); }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--primary-text-color); color: var(--primary-background-color); padding: 12px 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,.3); z-index: 10; max-width: 90vw; }
  .toast.error { background: var(--error-color); color: #fff; }
  @media (max-width: 600px) {
    .inner { padding: 12px; }
    .action-row { grid-template-columns: 1fr 1fr auto; }
    .action-row .check.small { grid-row: 2; }
    .head h1 { flex-basis: calc(100% - 48px); }
  }
`;

customElements.define("notify-manager-panel", NotifyManagerPanel);
