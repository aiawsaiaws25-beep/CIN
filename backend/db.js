// SQLite database setup, schema, and seed data for CineBook.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Allow tests to point at an isolated, throwaway database file.
const DB_PATH = process.env.CINEBOOK_DB_PATH || path.join(__dirname, 'data.sqlite');

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    genre TEXT NOT NULL,
    duration_min INTEGER NOT NULL,
    rating TEXT NOT NULL,
    description TEXT NOT NULL,
    poster_emoji TEXT NOT NULL DEFAULT '🎬'
  );

  CREATE TABLE IF NOT EXISTS cinemas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS showtimes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movie_id INTEGER NOT NULL REFERENCES movies(id),
    cinema_id INTEGER NOT NULL REFERENCES cinemas(id),
    start_time TEXT NOT NULL,
    price REAL NOT NULL,
    rows INTEGER NOT NULL DEFAULT 6,
    cols INTEGER NOT NULL DEFAULT 8
  );

  CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    showtime_id INTEGER NOT NULL REFERENCES showtimes(id),
    row_label TEXT NOT NULL,
    seat_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','booked')),
    UNIQUE(showtime_id, row_label, seat_number)
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    showtime_id INTEGER NOT NULL REFERENCES showtimes(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    total_amount REAL NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'paid',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS booking_seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    seat_id INTEGER NOT NULL UNIQUE REFERENCES seats(id)
  );
`);

function seed() {
  const movieCount = db.prepare('SELECT COUNT(*) AS c FROM movies').get().c;
  if (movieCount > 0) return;

  const insertMovie = db.prepare(
    `INSERT INTO movies (title, genre, duration_min, rating, description, poster_emoji)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const movies = [
    ['Galactic Drift', 'Sci-Fi', 128, 'PG-13', 'A crew of misfit explorers must outrun a collapsing star to save their colony ship.', '🚀'],
    ['The Last Recipe', 'Drama', 104, 'PG', 'A retired chef mentors a troubled teen through the family restaurant\'s final season.', '🍳'],
    ['Shadow Heist', 'Action', 112, 'R', 'A crew of thieves plans one last impossible job inside a floating vault city.', '🕶️'],
    ['Laugh Track', 'Comedy', 96, 'PG-13', 'A washed-up sitcom star gets a second chance when his old show goes viral for the wrong reasons.', '🎭'],
    ['Whispering Pines', 'Horror', 108, 'R', 'Campers discover the forest they chose for a reunion remembers every visitor who came before.', '🌲'],
    ['Pixel Kingdom', 'Animation', 98, 'G', 'A pixelated hero must restore color to a kingdom drained by a glitch in reality.', '🎮'],
  ];
  for (const m of movies) insertMovie.run(...m);

  const insertCinema = db.prepare(`INSERT INTO cinemas (name, location) VALUES (?, ?)`);
  const cinemas = [
    ['CineBook Downtown', '123 Main St, Metro City'],
    ['CineBook Riverside', '45 River Rd, Metro City'],
    ['CineBook Hillside', '9 Hilltop Ave, Metro City'],
  ];
  for (const c of cinemas) insertCinema.run(...c);

  const insertShowtime = db.prepare(
    `INSERT INTO showtimes (movie_id, cinema_id, start_time, price, rows, cols) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertSeat = db.prepare(
    `INSERT INTO seats (showtime_id, row_label, seat_number, status) VALUES (?, ?, ?, 'available')`
  );

  const movieIds = db.prepare('SELECT id FROM movies').all().map((r) => r.id);
  const cinemaIds = db.prepare('SELECT id FROM cinemas').all().map((r) => r.id);
  const times = ['10:30', '13:45', '17:00', '20:15'];
  const today = new Date();

  let showtimeCount = 0;
  for (const movieId of movieIds) {
    for (const cinemaId of cinemaIds) {
      // Two upcoming days per cinema/movie combo, two showtimes each.
      for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
        const date = new Date(today);
        date.setDate(date.getDate() + dayOffset);
        const dateStr = date.toISOString().slice(0, 10);
        const timesForDay = [times[showtimeCount % 4], times[(showtimeCount + 2) % 4]];
        for (const t of timesForDay) {
          const startTime = `${dateStr}T${t}:00`;
          const price = 9.5 + ((showtimeCount * 3) % 6);
          const rows = 6;
          const cols = 8;
          const result = insertShowtime.run(movieId, cinemaId, startTime, price, rows, cols);
          const showtimeId = Number(result.lastInsertRowid);
          const rowLabels = 'ABCDEFGH'.slice(0, rows).split('');
          for (const row of rowLabels) {
            for (let seatNum = 1; seatNum <= cols; seatNum++) {
              insertSeat.run(showtimeId, row, seatNum);
            }
          }
          showtimeCount++;
        }
      }
    }
  }
}

seed();

export function closeDb() {
  db.close();
}
