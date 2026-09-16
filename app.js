// CineBook frontend — vanilla JS single-page app with hash-based routing.
(function () {
  const app = document.getElementById('app');
  const API_BASE = window.CINEBOOK_API_BASE || '';

  /** In-memory selection state, kept in sync with the URL for reload/back support. */
  const state = {
    selectedSeats: [], // [{id, row_label, seat_number}]
  };

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value == null) continue; // skip null/undefined so e.g. disabled isn't set as "null"
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child == null) continue;
      node.append(child instanceof Node ? child : document.createTextNode(child));
    }
    return node;
  }

  async function api(path, options) {
    const res = await fetch(`${API_BASE}${path}`, options);
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const message = (body && body.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function formatMoney(n) {
    return `$${n.toFixed(2)}`;
  }

  // ---- Screens ----

  async function renderMovieList() {
    app.replaceChildren(el('p', { class: 'spinner-text' }, 'Loading movies…'));
    const movies = await api('/api/movies');
    const grid = el('div', { class: 'movie-grid' },
      movies.map((m) => el('a', { class: 'movie-card', href: `#/movie/${m.id}` }, [
        el('div', { class: 'movie-poster' }, m.poster_emoji),
        el('div', { class: 'movie-title' }, m.title),
        el('div', { class: 'movie-meta' }, `${m.genre} · ${m.duration_min} min · ${m.rating}`),
      ]))
    );
    app.replaceChildren(
      el('h1', {}, 'Now Showing'),
      el('p', { class: 'movie-meta' }, 'Pick a movie to see cinemas and showtimes.'),
      grid
    );
  }

  async function renderShowtimes(movieId) {
    app.replaceChildren(el('p', { class: 'spinner-text' }, 'Loading showtimes…'));
    const [movie, showtimes] = await Promise.all([
      api(`/api/movies/${movieId}`),
      api(`/api/movies/${movieId}/showtimes`),
    ]);

    const byCinema = new Map();
    for (const s of showtimes) {
      if (!byCinema.has(s.cinema_id)) byCinema.set(s.cinema_id, { name: s.cinema_name, location: s.cinema_location, items: [] });
      byCinema.get(s.cinema_id).items.push(s);
    }

    const groups = [...byCinema.values()].map((group) =>
      el('div', { class: 'cinema-group' }, [
        el('h3', {}, group.name),
        el('div', { class: 'cinema-location' }, group.location),
        el('div', { class: 'showtime-list' }, group.items.map((s) =>
          el('button', {
            class: 'showtime-chip',
            onclick: () => navigate(`#/seats/${s.id}`),
          }, [
            document.createTextNode(formatDateTime(s.start_time)),
            el('span', { class: 'price' }, formatMoney(s.price)),
          ])
        )),
      ])
    );

    app.replaceChildren(
      el('div', { class: 'breadcrumb' }, [el('a', { href: '#/' }, '← All movies')]),
      el('h1', {}, `${movie.poster_emoji} ${movie.title}`),
      el('p', { class: 'movie-meta' }, `${movie.genre} · ${movie.duration_min} min · ${movie.rating}`),
      el('p', {}, movie.description),
      el('h2', {}, 'Select a showtime'),
      groups.length ? el('div', {}, groups) : el('p', {}, 'No showtimes available.')
    );
  }

  async function renderSeatSelection(showtimeId) {
    app.replaceChildren(el('p', { class: 'spinner-text' }, 'Loading seat map…'));
    const showtime = await api(`/api/showtimes/${showtimeId}`);
    state.selectedSeats = [];

    const rows = new Map();
    for (const seat of showtime.seats) {
      if (!rows.has(seat.row_label)) rows.set(seat.row_label, []);
      rows.get(seat.row_label).push(seat);
    }

    const summary = el('div', { class: 'booking-summary' });

    function renderSummary() {
      const count = state.selectedSeats.length;
      const total = count * showtime.price;
      const seatLabels = state.selectedSeats
        .map((s) => `${s.row_label}${s.seat_number}`)
        .join(', ') || 'None';
      summary.replaceChildren(
        el('div', {}, [
          el('strong', {}, `Selected seats: `),
          document.createTextNode(seatLabels),
        ]),
        el('div', {}, [
          el('strong', {}, 'Total: '),
          document.createTextNode(formatMoney(total)),
        ]),
        el('button', {
          class: 'btn',
          onclick: () => {
            if (count === 0) return;
            sessionStorage.setItem('cinebook:selectedSeats', JSON.stringify(state.selectedSeats));
            sessionStorage.setItem('cinebook:showtimeId', String(showtimeId));
            navigate(`#/payment/${showtimeId}`);
          },
          ...(count === 0 ? { disabled: 'disabled' } : {}),
        }, `Proceed to payment (${count})`)
      );
    }

    const seatMapEl = el('div', { class: 'seat-map' },
      [...rows.entries()].map(([rowLabel, seats]) =>
        el('div', { class: 'seat-row' }, [
          el('span', { class: 'row-label' }, rowLabel),
          ...seats.map((seat) => {
            const isBooked = seat.status === 'booked';
            const btn = el('button', {
              class: 'seat',
              disabled: isBooked ? 'disabled' : null,
              title: `${rowLabel}${seat.seat_number}`,
              onclick: () => {
                if (isBooked) return;
                const idx = state.selectedSeats.findIndex((s) => s.id === seat.id);
                if (idx >= 0) {
                  state.selectedSeats.splice(idx, 1);
                  btn.classList.remove('selected');
                } else {
                  state.selectedSeats.push(seat);
                  btn.classList.add('selected');
                }
                renderSummary();
              },
            }, String(seat.seat_number));
            if (isBooked) btn.removeAttribute('onclick');
            return btn;
          }),
        ])
      )
    );

    app.replaceChildren(
      el('div', { class: 'breadcrumb' }, [el('a', { href: `#/movie/${showtime.movie_id}` }, '← Showtimes')]),
      el('h1', {}, `${showtime.poster_emoji} ${showtime.movie_title}`),
      el('p', { class: 'movie-meta' }, `${showtime.cinema_name} · ${formatDateTime(showtime.start_time)} · ${formatMoney(showtime.price)}/seat`),
      el('div', { class: 'screen-bar' }),
      el('div', { class: 'screen-label' }, 'SCREEN'),
      seatMapEl,
      el('div', { class: 'seat-legend' }, [
        el('span', {}, [el('span', { class: 'legend-swatch available' }), 'Available']),
        el('span', {}, [el('span', { class: 'legend-swatch selected' }), 'Selected']),
        el('span', {}, [el('span', { class: 'legend-swatch booked' }), 'Booked']),
      ]),
      summary
    );
    renderSummary();
  }

  async function renderPayment(showtimeId) {
    const seatsRaw = sessionStorage.getItem('cinebook:selectedSeats');
    const seats = seatsRaw ? JSON.parse(seatsRaw) : [];
    if (seats.length === 0) {
      navigate(`#/seats/${showtimeId}`);
      return;
    }
    app.replaceChildren(el('p', { class: 'spinner-text' }, 'Loading…'));
    const showtime = await api(`/api/showtimes/${showtimeId}`);
    const total = seats.length * showtime.price;

    const errorBox = el('div', {});

    const form = el('form', { class: 'form-card' }, [
      el('h2', {}, 'Payment details'),
      el('p', { class: 'movie-meta' }, `${showtime.movie_title} · ${formatDateTime(showtime.start_time)}`),
      el('p', { class: 'movie-meta' }, `Seats: ${seats.map((s) => `${s.row_label}${s.seat_number}`).join(', ')} · Total: ${formatMoney(total)}`),
      errorBox,
      el('div', { class: 'form-row' }, [el('label', {}, 'Full name'), el('input', { name: 'name', required: 'required', autocomplete: 'name' })]),
      el('div', { class: 'form-row' }, [el('label', {}, 'Email'), el('input', { name: 'email', type: 'email', required: 'required', autocomplete: 'email' })]),
      el('div', { class: 'form-row' }, [el('label', {}, 'Card number'), el('input', { name: 'cardNumber', required: 'required', maxlength: '19', placeholder: '4242 4242 4242 4242', autocomplete: 'cc-number' })]),
      el('div', { class: 'form-grid-2' }, [
        el('div', { class: 'form-row' }, [el('label', {}, 'Expiry (MM/YY)'), el('input', { name: 'expiry', required: 'required', placeholder: '12/28', autocomplete: 'cc-exp' })]),
        el('div', { class: 'form-row' }, [el('label', {}, 'CVV'), el('input', { name: 'cvv', required: 'required', maxlength: '4', placeholder: '123', autocomplete: 'cc-csc' })]),
      ]),
      el('button', { class: 'btn', type: 'submit' }, `Pay ${formatMoney(total)} (simulated)`),
    ]);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.replaceChildren();
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Processing payment…';
      try {
        const result = await api('/api/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            showtimeId: Number(showtimeId),
            seatIds: seats.map((s) => s.id),
            customer: { name: data.get('name'), email: data.get('email') },
            payment: { cardNumber: data.get('cardNumber'), expiry: data.get('expiry'), cvv: data.get('cvv') },
          }),
        });
        sessionStorage.removeItem('cinebook:selectedSeats');
        sessionStorage.removeItem('cinebook:showtimeId');
        navigate(`#/confirmation/${result.reference}`);
      } catch (err) {
        errorBox.replaceChildren(el('div', { class: 'error-banner' }, err.message));
        submitBtn.disabled = false;
        submitBtn.textContent = `Pay ${formatMoney(total)} (simulated)`;
        if (err.status === 409) {
          // Seat was taken by someone else — send the user back to pick again.
          setTimeout(() => navigate(`#/seats/${showtimeId}`), 1800);
        }
      }
    });

    app.replaceChildren(
      el('div', { class: 'breadcrumb' }, [el('a', { href: `#/seats/${showtimeId}` }, '← Seat selection')]),
      form
    );
  }

  async function renderConfirmation(reference) {
    app.replaceChildren(el('p', { class: 'spinner-text' }, 'Loading confirmation…'));
    const booking = await api(`/api/bookings/${reference}`);
    app.replaceChildren(
      el('div', { class: 'confirmation-card' }, [
        el('div', {}, '✅'),
        el('h1', {}, 'Booking confirmed!'),
        el('p', {}, 'Your booking reference:'),
        el('div', { class: 'confirmation-ref' }, booking.reference),
        el('div', { class: 'ticket-detail-row' }, [el('span', {}, 'Movie'), el('span', {}, `${booking.poster_emoji} ${booking.movie_title}`)]),
        el('div', { class: 'ticket-detail-row' }, [el('span', {}, 'Cinema'), el('span', {}, booking.cinema_name)]),
        el('div', { class: 'ticket-detail-row' }, [el('span', {}, 'Showtime'), el('span', {}, formatDateTime(booking.start_time))]),
        el('div', { class: 'ticket-detail-row' }, [el('span', {}, 'Seats'), el('span', {}, booking.seats.join(', '))]),
        el('div', { class: 'ticket-detail-row' }, [el('span', {}, 'Customer'), el('span', {}, booking.customer_name)]),
        el('div', { class: 'ticket-detail-row' }, [el('span', {}, 'Total paid'), el('span', {}, formatMoney(booking.total_amount))]),
        el('p', { class: 'movie-meta' }, 'A confirmation has been (simulated) sent to your email.'),
        el('a', { class: 'btn', href: '#/' }, 'Book another movie'),
      ])
    );
  }

  function renderError(err) {
    app.replaceChildren(
      el('div', { class: 'error-banner' }, err.message || 'Something went wrong.'),
      el('a', { class: 'btn', href: '#/' }, 'Back to home')
    );
  }

  function navigate(hash) {
    window.location.hash = hash;
  }

  async function router() {
    const hash = window.location.hash || '#/';
    try {
      let match;
      if (hash === '#/' || hash === '') {
        await renderMovieList();
      } else if ((match = hash.match(/^#\/movie\/(\d+)$/))) {
        await renderShowtimes(match[1]);
      } else if ((match = hash.match(/^#\/seats\/(\d+)$/))) {
        await renderSeatSelection(match[1]);
      } else if ((match = hash.match(/^#\/payment\/(\d+)$/))) {
        await renderPayment(match[1]);
      } else if ((match = hash.match(/^#\/confirmation\/([A-Za-z0-9-]+)$/))) {
        await renderConfirmation(match[1]);
      } else {
        await renderMovieList();
      }
      window.scrollTo(0, 0);
    } catch (err) {
      renderError(err);
    }
  }

  window.addEventListener('hashchange', router);
  window.addEventListener('DOMContentLoaded', router);
})();
