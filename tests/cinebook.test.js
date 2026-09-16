// QA test suite for CineBook.
// Run with: node --test tests
// Spins up the backend against a disposable SQLite file so tests never
// touch the real seeded data.sqlite used by `npm start`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, 'test-data.sqlite');

if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.CINEBOOK_DB_PATH = TEST_DB;
process.env.CINEBOOK_NO_LISTEN = '1';

const { server } = await import('../backend/server.js');
const { closeDb } = await import('../backend/db.js');

let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

async function api(pathname, options) {
  const res = await fetch(`${baseUrl}${pathname}`, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function samplePayment(overrides = {}) {
  return {
    customer: { name: 'Alice Example', email: 'alice@example.com' },
    payment: { cardNumber: '4242424242424242', expiry: '12/28', cvv: '123' },
    ...overrides,
  };
}

async function pickShowtimeWithAvailableSeats() {
  const { body: movies } = await api('/api/movies');
  const { body: showtimes } = await api(`/api/movies/${movies[0].id}/showtimes`);
  const showtimeId = showtimes[0].id;
  const { body: detail } = await api(`/api/showtimes/${showtimeId}`);
  const available = detail.seats.filter((s) => s.status === 'available');
  return { detail, available };
}

// ---- Complete booking process ----

test('browsing movies, cinemas, and showtimes returns seeded data', async () => {
  const { status, body: movies } = await api('/api/movies');
  assert.equal(status, 200);
  assert.ok(movies.length > 0, 'expected at least one movie');

  const { status: cinemaStatus, body: cinemas } = await api('/api/cinemas');
  assert.equal(cinemaStatus, 200);
  assert.ok(cinemas.length > 0, 'expected at least one cinema');

  const { status: stStatus, body: showtimes } = await api(`/api/movies/${movies[0].id}/showtimes`);
  assert.equal(stStatus, 200);
  assert.ok(showtimes.length > 0, 'expected showtimes for the first movie');
});

test('full booking flow: select seats, pay, and receive a confirmed booking', async () => {
  const { detail, available } = await pickShowtimeWithAvailableSeats();
  const seats = available.slice(0, 2);
  assert.ok(seats.length === 2, 'need at least two available seats for this test');

  const { status, body: booking } = await api('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      showtimeId: detail.id,
      seatIds: seats.map((s) => s.id),
      ...samplePayment(),
    }),
  });

  assert.equal(status, 201);
  assert.match(booking.reference, /^CB-[A-F0-9]{8}$/, 'booking reference should follow the CB-XXXXXXXX format');
  assert.equal(booking.seats.length, 2);

  const { status: getStatus, body: fetched } = await api(`/api/bookings/${booking.reference}`);
  assert.equal(getStatus, 200);
  assert.equal(fetched.reference, booking.reference);
  assert.equal(fetched.customer_email, 'alice@example.com');
  assert.deepEqual(fetched.seats.sort(), booking.seats.sort());

  // Seats should now show as booked in the seat map.
  const { body: refreshedDetail } = await api(`/api/showtimes/${detail.id}`);
  for (const seat of seats) {
    const updated = refreshedDetail.seats.find((s) => s.id === seat.id);
    assert.equal(updated.status, 'booked');
  }
});

test('ticket total equals seat count multiplied by showtime price', async () => {
  const { detail, available } = await pickShowtimeWithAvailableSeats();
  const seats = available.slice(0, 3);
  assert.ok(seats.length === 3, 'need at least three available seats for this test');

  const { status, body: booking } = await api('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      showtimeId: detail.id,
      seatIds: seats.map((s) => s.id),
      ...samplePayment({ customer: { name: 'Bob Total', email: 'bob@example.com' } }),
    }),
  });

  assert.equal(status, 201);
  const expectedTotal = 3 * detail.price;
  assert.equal(booking.totalAmount, expectedTotal);

  const { body: fetched } = await api(`/api/bookings/${booking.reference}`);
  assert.equal(fetched.total_amount, expectedTotal);
});

// ---- Double booking prevention ----

test('booking the same seat twice is rejected with a clear error', async () => {
  const { detail, available } = await pickShowtimeWithAvailableSeats();
  const seat = available[0];

  const first = await api('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      showtimeId: detail.id,
      seatIds: [seat.id],
      ...samplePayment({ customer: { name: 'First Buyer', email: 'first@example.com' } }),
    }),
  });
  assert.equal(first.status, 201);

  const second = await api('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      showtimeId: detail.id,
      seatIds: [seat.id],
      ...samplePayment({ customer: { name: 'Second Buyer', email: 'second@example.com' } }),
    }),
  });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already booked/i);
});

test('concurrent double-booking attempts for the same seat: only one succeeds', async () => {
  const { detail, available } = await pickShowtimeWithAvailableSeats();
  const seat = available[0];

  const makeRequest = (name) => api('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      showtimeId: detail.id,
      seatIds: [seat.id],
      ...samplePayment({ customer: { name, email: `${name}@example.com` } }),
    }),
  });

  const [r1, r2] = await Promise.all([makeRequest('Racer1'), makeRequest('Racer2')]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409], 'exactly one of the two concurrent bookings should succeed');
});

// ---- Clear error responses ----

test('booking an unknown seat id returns a 404 with a clear message', async () => {
  const { detail } = await pickShowtimeWithAvailableSeats();
  const { status, body } = await api('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      showtimeId: detail.id,
      seatIds: [999999],
      ...samplePayment(),
    }),
  });
  assert.equal(status, 404);
  assert.match(body.error, /does not exist/i);
});

test('booking without customer or payment details returns 400', async () => {
  const { detail, available } = await pickShowtimeWithAvailableSeats();
  const { status, body } = await api('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ showtimeId: detail.id, seatIds: [available[0].id] }),
  });
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('unknown booking reference returns 404', async () => {
  const { status, body } = await api('/api/bookings/CB-DOESNOTEX');
  assert.equal(status, 404);
  assert.ok(body.error);
});

// ---- Responsive layout checks ----

test('frontend declares a mobile viewport and responsive CSS breakpoints', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1.0"/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'styles.css'), 'utf8');
  assert.match(css, /@media \(max-width: 600px\)/, 'expected a mobile breakpoint');
  assert.match(css, /@media \(min-width: 900px\)/, 'expected a desktop breakpoint');
  assert.match(css, /grid-template-columns: repeat\(auto-fill/, 'expected a responsive fluid grid for movie cards');
});

test('static frontend files are served by the app server', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /CineBook/);

  const cssRes = await fetch(`${baseUrl}/styles.css`);
  assert.equal(cssRes.status, 200);
  assert.equal(cssRes.headers.get('content-type'), 'text/css; charset=utf-8');
});
