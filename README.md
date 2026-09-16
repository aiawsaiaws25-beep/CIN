# CineBook 🎬

A complete movie cinema ticket-booking web application: browse movies, pick a
cinema and showtime, select seats on a live seat map, pay (simulated), and get
an instant booking confirmation with a unique reference.

Built with **zero external dependencies** — a Node.js `http` server backed by
the built-in `node:sqlite` module, and a small vanilla-JS single-page frontend.
No `npm install` required.

## Project structure

```
CIN/
├── backend/
│   ├── server.js       # HTTP server, REST API routes, booking logic
│   ├── db.js           # SQLite schema + seed data (movies, cinemas, showtimes, seats)
│   ├── package.json
│   └── data.sqlite     # created automatically on first run
├── frontend/
│   ├── index.html
│   ├── styles.css      # responsive layout (mobile + desktop)
│   └── app.js          # hash-router SPA: browse → seats → payment → confirmation
├── tests/
│   └── cinebook.test.js # QA suite (Node's built-in test runner)
└── README.md
```

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite` module). Tested on Node 24.

## Running the app

```powershell
cd backend
node server.js
```

Then open **http://localhost:3000** in a browser. The database is created and
seeded automatically on first run (6 movies, 3 cinemas, showtimes over two
days, 48-seat maps per showtime).

## Running the tests

```powershell
node --test tests/cinebook.test.js
```

The test suite spins up the server against a disposable, isolated SQLite file
(`tests/test-data.sqlite`, deleted automatically after the run) so it never
touches your real `backend/data.sqlite`.

### What's covered

- Browsing movies, cinemas, and showtimes
- End-to-end booking flow (select seats → pay → confirmation → look up by reference)
- Ticket total calculation (seats × price)
- Booking the same seat twice → rejected with a clear `409` error
- Concurrent double-booking race (two simultaneous requests for one seat → exactly one succeeds)
- Invalid/missing seat, customer, or payment data → clear `400`/`404` errors
- Unknown booking reference → `404`
- Responsive layout: viewport meta tag + mobile/desktop CSS breakpoints present
- Static file serving

All 10 tests pass.

## How booking conflicts are prevented

Each seat row is unique per `(showtime_id, row_label, seat_number)` and carries
an `available`/`booked` status. A booking request runs inside a SQLite
transaction (`BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`) that re-checks every
requested seat's status before marking it booked. Since `node:sqlite` runs
synchronously on a single connection, this transaction is effectively
serialized against concurrent requests in the same process, so two people
booking the same seat at the same time will never both succeed — the second
request gets a `409 Conflict` with a message like:

> "Seat A1 is already booked. Please choose another seat."

## API overview

| Method | Path                          | Description                          |
|--------|-------------------------------|---------------------------------------|
| GET    | `/api/movies`                 | List all movies                       |
| GET    | `/api/movies/:id`              | Movie details                        |
| GET    | `/api/movies/:id/showtimes`    | Showtimes (with cinema info) for a movie |
| GET    | `/api/cinemas`                 | List all cinemas                     |
| GET    | `/api/showtimes/:id`           | Showtime details + full seat map     |
| POST   | `/api/bookings`                | Create a booking (seats + customer + simulated payment) |
| GET    | `/api/bookings/:reference`     | Look up a booking by its reference   |

`POST /api/bookings` body:

```json
{
  "showtimeId": 1,
  "seatIds": [12, 13],
  "customer": { "name": "Jane Doe", "email": "jane@example.com" },
  "payment": { "cardNumber": "4242 4242 4242 4242", "expiry": "12/28", "cvv": "123" }
}
```

Payments are **simulated only** — no real card processing or external payment
gateway is used; any well-formed card details are accepted.

## Frontend screens

1. **Movies** — browsable grid of now-showing movies.
2. **Showtimes** — cinemas and showtime chips for the selected movie.
3. **Seat selection** — live seat map showing available (green), selected
   (red), and booked (grey, disabled) seats, with a running total.
4. **Payment** — simulated card form with order summary.
5. **Confirmation** — booking reference, seats, cinema, showtime, and total paid.

The layout is fully responsive: a fluid movie grid, a horizontally-scrollable
seat map on narrow screens, and a stacked booking summary on mobile
(breakpoints at 600px and 900px in `frontend/styles.css`).
