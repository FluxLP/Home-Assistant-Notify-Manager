<p align="center"><img src="custom_components/notify_manager/brand/icon@2x.png" width="160" alt="Notify Manager"></p>

# Notify Manager für Home Assistant

Eine eigene Seite in der Seitenleiste – ähnlich wie der [Switch Manager](https://github.com/Sian-Lee-SA/Home-Assistant-Switch-Manager) –,
auf der du **Benachrichtigungs-Vorlagen** anlegst und sie dann in Automationen als Aktion verwendest.

## Funktionen

- **Vorlagen** mit Titel, Text und Variablen (`{{ geraet }}`, beliebiges Jinja)
- **Empfänger**: fasse die Handys/Tablets einer Person zusammen (z.B. „Felix“ = iPhone + iPad)
- **Kanäle pro Vorlage**
  - Handy-Push über die Home-Assistant-App (iOS & Android)
  - Amazon Echo über [Alexa Media Player](https://github.com/alandtse/alexa_media_player) – Ansage mit Gong oder reines TTS
  - Music Assistant (`play_announcement`, inkl. Ansage-Lautstärke)
  - beliebige weitere Media Player per `tts.speak`
  - Benachrichtigung in Home Assistant
- **Priorität**: normal, zeitkritisch oder **kritisch** (kommt auch bei „Nicht stören“ mit Ton durch)
- **Aktions-Buttons**: Bestätigen, Ablehnen, Später, Antworten (Texteingabe) oder eigene
- **Auf Antwort warten**: die Automation bekommt die gedrückte Taste als Rückgabewert und kann verzweigen
- Ruhezeiten und „nur ansagen, wenn jemand zu Hause ist“ für Lautsprecher
- Verlauf der gesendeten Nachrichten inkl. Antworten

## Installation

### HACS
1. HACS → ⋮ → *Benutzerdefinierte Repositories* → `https://github.com/FluxLP/Home-Assistant-Notify-Manager`, Typ *Integration*
2. „Notify Manager“ installieren und Home Assistant neu starten
3. *Einstellungen → Geräte & Dienste → Integration hinzufügen → Notify Manager*

### Manuell
Den Ordner `custom_components/notify_manager` nach `/config/custom_components/` kopieren, neu starten, Integration hinzufügen.

## In Automationen verwenden

Jede Vorlage bekommt einen eigenen Dienst, der in der Aktionsauswahl unter „Notify Manager“ erscheint.
Variablen der Vorlage werden dort zu eigenen Feldern.

```yaml
action: notify_manager.waschmaschine_fertig
data:
  geraet: Waschmaschine
response_variable: antwort
```

Ist bei der Vorlage *Automation wartet auf Antwort* aktiv (oder `wait: true`), läuft die Automation erst weiter,
wenn ein Button gedrückt wurde oder das Zeitlimit abgelaufen ist:

```yaml
- choose:
    - conditions: "{{ antwort.response == 'bestaetigt' }}"
      sequence: [...]
    - conditions: "{{ antwort.response == 'abgelehnt' }}"
      sequence: [...]
  default: [...]   # antwort.response == 'timeout'
```

Rückgabewert:

| Feld | Inhalt |
|---|---|
| `response` | Schlüssel des Buttons, `timeout` oder `sent` (ohne Warten) |
| `response_title` | Beschriftung des Buttons |
| `reply_text` | Text bei Buttons mit Texteingabe |
| `device` | Gerät, auf dem geantwortet wurde |
| `request_id`, `title`, `message`, `errors` | Details zur gesendeten Nachricht |

### Allgemeiner Dienst

```yaml
action: notify_manager.send
data:
  template: waschmaschine_fertig   # ID, Dienstname oder Name
  variables:
    geraet: Trockner
  priority: critical               # optional: überschreibt die Vorlage
  recipients: [Felix]              # optional
  wait: true
  timeout: 600
response_variable: antwort
```

### Events

- `notify_manager_sent` – nach jedem Versand
- `notify_manager_response` – wenn ein Button gedrückt wurde oder das Zeitlimit abläuft (`response: timeout`)

```yaml
trigger: event
event_type: notify_manager_response
event_data:
  template: Waschmaschine fertig
  response: spaeter
```

## Hinweise

- **Kritische Hinweise auf iOS** müssen in den iOS-Einstellungen für die Home-Assistant-App erlaubt sein.
- Nach einer Antwort wird die Nachricht auf allen anderen Geräten automatisch entfernt (abschaltbar).
- Der Verlauf liegt nur im Speicher und wird bei einem Neustart geleert.
