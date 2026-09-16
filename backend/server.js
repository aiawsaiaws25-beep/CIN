// Minimal dependency-free HTTP server exposing the CineBook REST API
// and serving the static frontend from ../frontend.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function generateBookingReference() {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `CB-${random}`;
}

// ---- Data access helpers ----

function listMovies() {
  return db.prepare('SELECT * FROM movies ORDER BY title').all();
}

function getMovie(id) {
  return db.prepare('SELECT * FROM movies WHERE id = ?').get(id);
}

function listCinemas() {
  return db.prepare('SELECT * FROM cinemas ORDER BY name').all();
}

function listShowtimesForMovie(movieId) {
  return db
    .prepare(
      `SELECT s.*, c.name AS cinema_name, c.location AS cinema_location
       FROM showtimes s
       JOIN cinemas c ON c.id = s.cinema_id
       WHERE s.movie_id = ?
       ORDER BY s.start_time`
    )
    .all(movieId);
}

function getShowtimeDetail(showtimeId) {
  const showtime = db
    .prepare(
      `SELECT s.*, m.title AS movie_title, m.poster_emoji, c.name AS cinema_name, c.location AS cinema_location
       FROM showtimes s
       JOIN movies m ON m.id = s.movie_id
       JOIN cinemas c ON c.id = s.cinema_id
       WHERE s.id = ?`
    )
    .get(showtimeId);
  if (!showtime) return null;
  const seats = db
    .prepare('SELECT id, row_label, seat_number, status FROM seats WHERE showtime_id = ? ORDER BY row_label, seat_number')
    .all(showtimeId);
  return { ...showtime, seats };
}

function createBooking({ showtimeId, seatIds, customer, payment }) {
  const showtime = db.prepare('SELECT * FROM showtimes WHERE id = ?').get(showtimeId);
  if (!showtime) {
    throw { error: 404, message: 'Showtime not found.' };
  }
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw { error: 400, message: 'At least one seat must be selected.' };
  }
  if (!customer?.name || !customer?.email) {
    throw { error: 400, message: 'Customer name and email are required.' };
  }
  if (!payment?.cardNumber || !payment?.expiry || !payment?.cvv) {
    throw { error: 400, message: 'Payment details are required.' };
  }

  // node:sqlite runs synchronously on a single connection, so this
  // transaction is effectively serialized against concurrent requests.
  db.exec('BEGIN IMMEDIATE');
  try {
    const seatRows = [];
    for (const seatId of seatIds) {
      const seat = db
        .prepare('SELECT * FROM seats WHERE id = ? AND showtime_id = ?')
        .get(seatId, showtimeId);
      if (!seat) {
        throw { error: 404, message: `Seat ${seatId} does not exist for this showtime.` };
      }
      if (seat.status !== 'available') {
        throw {
          error: 409,
          message: `Seat ${seat.row_label}${seat.seat_number} is already booked. Please choose another seat.`,
        };
      }
      seatRows.push(seat);
    }

    const customerRow = db
      .prepare('INSERT INTO customers (name, email) VALUES (?, ?)')
      .run(customer.name, customer.email);
    const customerId = Number(customerRow.lastInsertRowid);

    const totalAmount = seatRows.length * showtime.price;

    let reference = generateBookingReference();
    // Extremely unlikely collision, but guard anyway.
    while (db.prepare('SELECT 1 FROM bookings WHERE reference = ?').get(reference)) {
      reference = generateBookingReference();
    }

    const bookingRow = db
      .prepare(
        `INSERT INTO bookings (reference, showtime_id, customer_id, total_amount, payment_status)
         VALUES (?, ?, ?, ?, 'paid')`
      )
      .run(reference, showtimeId, customerId, totalAmount);
    const bookingId = Number(bookingRow.lastInsertRowid);

    const updateSeat = db.prepare("UPDATE seats SET status = 'booked' WHERE id = ?");
    const insertBookingSeat = db.prepare('INSERT INTO booking_seats (booking_id, seat_id) VALUES (?, ?)');
    for (const seat of seatRows) {
      updateSeat.run(seat.id);
      insertBookingSeat.run(bookingId, seat.id);
    }

    db.exec('COMMIT');

    return {
      reference,
      bookingId,
      totalAmount,
      seats: seatRows.map((s) => `${s.row_label}${s.seat_number}`),
    };
  } catch (err) {
    db.exec('ROLLBACK');
    if (err && err.error) throw err;
    throw { error: 500, message: 'Unable to complete booking.' };
  }
}

function getBookingByReference(reference) {
  const booking = db
    .prepare(
      `SELECT b.*, s.start_time, s.movie_id, s.cinema_id, m.title AS movie_title, m.poster_emoji,
              c.name AS cinema_name, c.location AS cinema_location, cu.name AS customer_name, cu.email AS customer_email
       FROM bookings b
       JOIN showtimes s ON s.id = b.showtime_id
       JOIN movies m ON m.id = s.movie_id
       JOIN cinemas c ON c.id = s.cinema_id
       JOIN customers cu ON cu.id = b.customer_id
       WHERE b.reference = ?`
    )
    .get(reference);
  if (!booking) return null;
  const seats = db
    .prepare(
      `SELECT se.row_label, se.seat_number
       FROM booking_seats bs
       JOIN seats se ON se.id = bs.seat_id
       WHERE bs.booking_id = ?
       ORDER BY se.row_label, se.seat_number`
    )
    .all(booking.id);
  return { ...booking, seats: seats.map((s) => `${s.row_label}${s.seat_number}`) };
}

// ---- Static file serving ----

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(FRONTEND_DIR, filePath);
  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback for client-side routes.
      fs.readFile(path.join(FRONTEND_DIR, 'index.html'), (err2, indexData) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- Router ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  try {
    if (pathname === '/api/movies' && method === 'GET') {
      return sendJson(res, 200, listMovies());
    }

    let match;
    if ((match = pathname.match(/^\/api\/movies\/(\d+)$/)) && method === 'GET') {
      const movie = getMovie(match[1]);
      if (!movie) return sendJson(res, 404, { error: 'Movie not found.' });
      return sendJson(res, 200, movie);
    }

    if ((match = pathname.match(/^\/api\/movies\/(\d+)\/showtimes$/)) && method === 'GET') {
      const movie = getMovie(match[1]);
      if (!movie) return sendJson(res, 404, { error: 'Movie not found.' });
      return sendJson(res, 200, listShowtimesForMovie(match[1]));
    }

    if (pathname === '/api/cinemas' && method === 'GET') {
      return sendJson(res, 200, listCinemas());
    }

    if ((match = pathname.match(/^\/api\/showtimes\/(\d+)$/)) && method === 'GET') {
      const showtime = getShowtimeDetail(match[1]);
      if (!showtime) return sendJson(res, 404, { error: 'Showtime not found.' });
      return sendJson(res, 200, showtime);
    }

    if (pathname === '/api/bookings' && method === 'POST') {
      const body = await readBody(req);
      try {
        const result = createBooking(body);
        return sendJson(res, 201, result);
      } catch (err) {
        const status = err?.error || 500;
        return sendJson(res, status, { error: err?.message || 'Booking failed.' });
      }
    }

    if ((match = pathname.match(/^\/api\/bookings\/([A-Za-z0-9-]+)$/)) && method === 'GET') {
      const booking = getBookingByReference(match[1]);
      if (!booking) return sendJson(res, 404, { error: 'Booking not found.' });
      return sendJson(res, 200, booking);
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Not found.' });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    return sendJson(res, 500, { error: 'Internal server error.', detail: String(err?.message || err) });
  }
});

// Tests import this module after setting CINEBOOK_NO_LISTEN and start the
// server themselves on an ephemeral port to run in isolation.
if (!process.env.CINEBOOK_NO_LISTEN) {
  server.listen(PORT, () => {
    console.log(`CineBook server running at http://localhost:${PORT}`);
  });
}

export { server, createBooking, getShowtimeDetail, getBookingByReference };
