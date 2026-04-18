# Kwadrantenpoll

Real-time 2D kwadranten-poll webapp voor workshops. Deelnemers plaatsen zichzelf per vraag op een grafiek met **Pedagogische meerwaarde** (X) en **Risico** (Y). Iedereen ziet live alle stippen met namen.

## Online zetten — 1 klik

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mathiasvdh/kwadrantenpoll)

Klik de knop, log in op Render (gratis), Render leest de `render.yaml` in en deployt automatisch. Na ±2 minuten krijg je een publieke URL zoals `https://kwadrantenpoll.onrender.com`. Admin zit op `/admin`, deelnemers op `/`.

> Render zet de service in slaap na 15 min inactiviteit op het gratis plan (eerste request na slaap duurt ±30 s). Voor altijd-aan heb je het Starter-plan ($7/mnd) nodig.

## Lokaal starten

```bash
npm install
npm start
```

- Facilitator: http://localhost:3000/admin
- Deelnemers: http://localhost:3000/ (of scan de QR-code)

Poort aanpassen: `PORT=8080 npm start`.

## Gebruik

1. Open `/admin` — er wordt automatisch een 4-cijferige sessiecode + QR-code gegenereerd.
2. Toon de QR-code groot via de knop **QR groot** bovenaan (klik op QR om fullscreen).
3. Lanceer een vraag vanuit het zijpaneel (sectie **Komende**).
4. Deelnemers tikken of klikken op de grafiek om zichzelf te plaatsen; ze kunnen blijven verschuiven zolang de vraag open is.
5. Sluit de vraag, heropen indien nodig, reset antwoorden, of lanceer de volgende vraag.
6. **PNG**-knop exporteert de huidige grafiek, **CSV**-knop de volledige sessie.

### Zijpaneel

- **Gelanceerd** — alle actieve + afgesloten vragen. Klik om de grafiek te bekijken.
- **Komende** — enkel zichtbaar voor de facilitator; per vraag een "Lanceer"-knop.
- Status-iconen: 🟢 actief, 🔒 gesloten, ⚪ komende (admin).

Deelnemers kunnen afgesloten vragen bekijken in **review-modus** (read-only, met banner). Een nieuwe vraag pusht niet automatisch — er verschijnt wel een notificatie rechtsboven.

### Blind mode

Toggle in de admin-topbar. Namen worden verborgen op álle client-schermen (de eigen stip blijft gelabeld). Handig om bias te vermijden voordat iedereen geplaatst heeft.

## Vragen aanpassen

Open [`server.js`](server.js) en pas de array `questions` bovenaan aan. Elke vraag heeft een uniek numeriek `id` en een `text`:

```js
const questions = [
  { id: 1, text: "Jouw eerste vraag…" },
  { id: 2, text: "Jouw tweede vraag…" },
  // …
];
```

Herstart de server na wijzigingen. Tip: laat de `id`-waarden stabiel als je een oude sessie-snapshot wil kunnen herladen.

## State en persistentie

- Alles staat in-memory (`Map`) — geen database nodig.
- Elke 5 s wordt een snapshot weggeschreven naar `sessions-snapshot.json` zodat een herstart geen data wist.
- Sessies verlopen na **6 u inactiviteit**.

## Deploy

### Render / Railway / Fly.io

De app werkt out-of-the-box met `node server.js`. Vereisten:

- Node 20+
- Persistent disk aan `/app` als je de snapshot wil bewaren tussen deploys (anders wissen restarts de historiek).

Environment:

| Var | Default | Beschrijving |
|---|---|---|
| `PORT` | `3000` | HTTP-poort |
| `SNAPSHOT_PATH` | `./sessions-snapshot.json` | Locatie snapshot |

### Docker

```bash
docker build -t kwadrantenpoll .
docker run -p 3000:3000 -v $(pwd)/data:/app/data \
  -e SNAPSHOT_PATH=/app/data/sessions.json kwadrantenpoll
```

### Render (quick)

1. New → Web Service → connect repo.
2. Build: `npm install`. Start: `npm start`. Node 20.
3. (Optioneel) voeg een persistent disk toe gemount op `/app/data` en zet `SNAPSHOT_PATH=/app/data/sessions.json`.

## Socket.IO events

**Server → Client**

- `session-state` — bij join: huidige vraag + deelnemers
- `question-history` — bij join: alle gelanceerde vragen + posities
- `question-active` { questionId, questionText, positions }
- `question-closed` { questionId }
- `question-reopened` { questionId }
- `question-reset` { questionId }
- `position-update` { questionId, userId, name, color, x, y, timestamp }
- `blind-mode-changed` { value }
- `participant-joined` / `participant-left`

**Client → Server**

- `join-session` { code, name, userId? } → ack { ok, userId, color }
- `submit-position` { questionId, x, y } (0–100)
- `admin-create-session` → ack { ok, state }
- `admin-reconnect` { code, adminToken } → ack { ok, state }
- `activate-question` { questionId }
- `close-question`
- `reopen-question` { questionId }
- `reset-question` { questionId }
- `toggle-blind` { value }

## Architectuur-korte versie

```
server.js        Express + Socket.IO, in-memory sessies, snapshot
public/
├── index.html   deelnemer-UI (code → naam → main)
├── admin.html   facilitator-UI
├── css/style.css
└── js/
    ├── chart.js        QuadrantChart (SVG rendering, labels, PNG export)
    ├── participant.js  deelnemer socket + state
    └── admin.js        facilitator socket + state
```

De grafiek is één SVG van 600×600 viewBox. X ∈ [0..100] maps naar plot-X ∈ [60..580]; Y ∈ [0..100] maps invers naar plot-Y ∈ [540..30]. Labels worden via een simpele rechthoek-collision check naar een van 8 offsets geplaatst; bij 30+ deelnemers verschijnt een "namen bij hover"-toggle.

## Admin-token en sessieherstel

- `/admin` genereert een `adminToken` die in `sessionStorage` bewaard wordt. Herladen herstelt admin-rechten voor dezelfde tab.
- Token sluiten of een andere browser = nieuwe sessie. Ter bescherming tegen "per ongeluk admin worden".
- CSV-export vereist de token in de querystring (server-side check).

## Limieten

- Max 200 deelnemers per sessie (server-side assert).
- Naam 1–30 tekens, HTML-escaped bij rendering (XSS-veilig).
- Codes zijn 4 cijfers (1000–9999). Theoretisch 9000 parallelle sessies.

## Licentie

MIT
