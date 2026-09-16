// CineBook static data + in-browser "database" for GitHub Pages (no backend).
// Movies/cinemas/showtimes are fixed seed data; seat status and bookings are
// persisted in localStorage, scoped to this browser only.
(function () {
  const MOVIES = [
    { id: 1, title: 'Galactic Drift', genre: 'Sci-Fi', duration_min: 128, rating: 'PG-13', description: 'A crew of misfit explorers must outrun a collapsing star to save their colony ship.', poster_emoji: '🚀' },
    { id: 2, title: 'The Last Recipe', genre: 'Drama', duration_min: 104, rating: 'PG', description: "A retired chef mentors a troubled teen through the family restaurant's final season.", poster_emoji: '🍳' },
    { id: 3, title: 'Shadow Heist', genre: 'Action', duration_min: 112, rating: 'R', description: 'A crew of thieves plans one last impossible job inside a floating vault city.', poster_emoji: '🕶️' },
    { id: 4, title: 'Laugh Track', genre: 'Comedy', duration_min: 96, rating: 'PG-13', description: "A washed-up sitcom star gets a second chance when his old show goes viral for the wrong reasons.", poster_emoji: '🎭' },
    { id: 5, title: 'Whispering Pines', genre: 'Horror', duration_min: 108, rating: 'R', description: 'Campers discover the forest they chose for a reunion remembers every visitor who came before.', poster_emoji: '🌲' },
    { id: 6, title: 'Pixel Kingdom', genre: 'Animation', duration_min: 98, rating: 'G', description: 'A pixelated hero must restore color to a kingdom drained by a glitch in reality.', poster_emoji: '🎮' },
  ];

  const CINEMAS = [
    { id: 1, name: 'CineBook Downtown', location: '123 Main St, Metro City' },
    { id: 2, name: 'CineBook Riverside', location: '45 River Rd, Metro City' },
    { id: 3, name: 'CineBook Hillside', location: '9 Hilltop Ave, Metro City' },
  ];

  const TIMES = ['10:30', '13:45', '17:00', '20:15'];
  const ROWS = 6;
  const COLS = 8;

  function buildShowtimes() {
    const showtimes = [];
    let showtimeId = 1;
    let counter = 0;
    const today = new Date();
    for (const movie of MOVIES) {
      for (const cinema of CINEMAS) {
        for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
          const date = new Date(today);
          date.setDate(date.getDate() + dayOffset);
          const dateStr = date.toISOString().slice(0, 10);
          const timesForDay = [TIMES[counter % 4], TIMES[(counter + 2) % 4]];
          for (const t of timesForDay) {
            showtimes.push({
              id: showtimeId++,
              movie_id: movie.id,
              cinema_id: cinema.id,
              start_time: `${dateStr}T${t}:00`,
              price: 9.5 + ((counter * 3) % 6),
              rows: ROWS,
              cols: COLS,
              cinema_name: cinema.name,
              cinema_location: cinema.location,
            });
            counter++;
          }
        }
      }
    }
    return showtimes;
  }

  const SHOWTIMES = buildShowtimes();

  const BOOKED_SEATS_KEY = 'cinebook:bookedSeats';
  const BOOKINGS_KEY = 'cinebook:bookings';

  function readBookedSeats() {
    try {
      return JSON.parse(localStorage.getItem(BOOKED_SEATS_KEY)) || {};
    } catch {
      return {};
    }
  }
  function writeBookedSeats(map) {
    localStorage.setItem(BOOKED_SEATS_KEY, JSON.stringify(map));
  }
  function readBookings() {
    try {
      return JSON.parse(localStorage.getItem(BOOKINGS_KEY)) || [];
    } catch {
      return [];
    }
  }
  function writeBookings(list) {
    localStorage.setItem(BOOKINGS_KEY, JSON.stringify(list));
  }

  function seatId(showtimeId, row, num) {
    return `${showtimeId}-${row}-${num}`;
  }

  function generateReference() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `CB-${hex}`;
  }

  const Store = {
    listMovies() {
      return [...MOVIES].sort((a, b) => a.title.localeCompare(b.title));
    },
    getMovie(id) {
      return MOVIES.find((m) => m.id === Number(id)) || null;
    },
    listCinemas() {
      return CINEMAS;
    },
    listShowtimesForMovie(movieId) {
      return SHOWTIMES.filter((s) => s.movie_id === Number(movieId)).sort((a, b) => a.start_time.localeCompare(b.start_time));
    },
    getShowtimeDetail(showtimeId) {
      const showtime = SHOWTIMES.find((s) => s.id === Number(showtimeId));
      if (!showtime) return null;
      const movie = this.getMovie(showtime.movie_id);
      const booked = readBookedSeats();
      const seats = [];
      const rowLabels = 'ABCDEFGH'.slice(0, showtime.rows).split('');
      for (const row of rowLabels) {
        for (let num = 1; num <= showtime.cols; num++) {
          const id = seatId(showtime.id, row, num);
          seats.push({ id, row_label: row, seat_number: num, status: booked[id] ? 'booked' : 'available' });
        }
      }
      return { ...showtime, movie_title: movie.title, poster_emoji: movie.poster_emoji, seats };
    },
    createBooking({ showtimeId, seatIds, customer, payment }) {
      const showtime = SHOWTIMES.find((s) => s.id === Number(showtimeId));
      if (!showtime) throw { status: 404, message: 'Showtime not found.' };
      if (!Array.isArray(seatIds) || seatIds.length === 0) throw { status: 400, message: 'At least one seat must be selected.' };
      if (!customer?.name || !customer?.email) throw { status: 400, message: 'Customer name and email are required.' };
      if (!payment?.cardNumber || !payment?.expiry || !payment?.cvv) throw { status: 400, message: 'Payment details are required.' };

      const booked = readBookedSeats();
      const seatLabels = [];
      for (const id of seatIds) {
        const [, row, num] = String(id).split('-');
        if (!row || !num) throw { status: 404, message: `Seat ${id} does not exist for this showtime.` };
        if (booked[id]) throw { status: 409, message: `Seat ${row}${num} is already booked. Please choose another seat.` };
        seatLabels.push(`${row}${num}`);
      }

      for (const id of seatIds) booked[id] = true;
      writeBookedSeats(booked);

      const reference = generateReference();
      const totalAmount = seatIds.length * showtime.price;
      const movie = this.getMovie(showtime.movie_id);
      const booking = {
        reference,
        showtimeId: showtime.id,
        seats: seatLabels,
        customer_name: customer.name,
        customer_email: customer.email,
        total_amount: totalAmount,
        movie_title: movie.title,
        poster_emoji: movie.poster_emoji,
        cinema_name: showtime.cinema_name,
        start_time: showtime.start_time,
        createdAt: new Date().toISOString(),
      };
      const bookings = readBookings();
      bookings.push(booking);
      writeBookings(bookings);
      return booking;
    },
    getBookingByReference(reference) {
      return readBookings().find((b) => b.reference === reference) || null;
    },
  };

  window.CineBookStore = Store;
})();
