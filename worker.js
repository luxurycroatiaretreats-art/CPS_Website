const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── NOVI ENDPOINT: lista svih vila ──
      if (path === '/api/villas' && request.method === 'GET') {
        return await getVillas(env);
      }

      // ── NOVI ENDPOINT: dohvat podataka vile ──
      if (path.startsWith('/api/villa/') && request.method === 'GET') {
        const villaId = path.split('/')[3];
        return await getVilla(villaId, env);
      }

      if (path === '/api/booking/create' && request.method === 'POST') {
        return await createBooking(request, env);
      }
      if (path === '/api/booking/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env);
      }
      if (path.startsWith('/api/availability/') && request.method === 'GET') {
        const villaId = path.split('/')[3];
        return await getAvailability(villaId, env);
      }
      if (path === '/api/booking/cancel' && request.method === 'POST') {
        return await cancelBooking(request, env);
      }
      if (path.startsWith('/api/booking/') && request.method === 'GET') {
        const bookingId = path.split('/')[3];
        return await getBooking(bookingId, env);
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  },

  async scheduled(event, env) {
    await chargeBalances(env);
  }
};

// ─── LISTA SVIH VILA ─────────────────────────────────────────────────────────
async function getVillas(env) {
  const result = await env.DB.prepare(`
    SELECT villa_id, villa_name, price_per_night, cleaning_fee,
           security_deposit, payment_policy_days, max_guests,
           location, image_url, rating, active
    FROM villas WHERE active = 1
    ORDER BY rowid ASC
  `).all();

  return new Response(JSON.stringify(result.results), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// ─── DOHVAT VILE ──────────────────────────────────────────────────────────────
async function getVilla(villa_id, env) {
  const villa = await env.DB.prepare(`
    SELECT villa_id, villa_name, price_per_night, cleaning_fee, 
           security_deposit, payment_policy_days, max_guests
    FROM villas WHERE villa_id = ? AND active = 1
  `).bind(villa_id).first();

  if (!villa) {
    return new Response(JSON.stringify({ error: 'Vila nije pronađena' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify(villa), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// ─── KREIRANJE BOOKINGA ───────────────────────────────────────────────────────
async function createBooking(request, env) {
  const body = await request.json();

  const {
    villa_id,
    guest_name,
    guest_email,
    guest_phone,
    check_in,
    check_out,
    guests,
  } = body;

  // Validacija
  if (!villa_id || !guest_name || !guest_email || !check_in || !check_out) {
    return new Response(JSON.stringify({ error: 'Nedostaju obavezni podaci' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // ── Dohvati podatke vile iz baze (ne od clienta!) ──
  const villa = await env.DB.prepare(`
    SELECT * FROM villas WHERE villa_id = ? AND active = 1
  `).bind(villa_id).first();

  if (!villa) {
    return new Response(JSON.stringify({ error: 'Vila nije pronađena' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const price_per_night      = villa.price_per_night;
  const cleaning_fee         = villa.cleaning_fee || 0;
  const payment_policy_days  = villa.payment_policy_days || 30;
  const villa_name           = villa.villa_name;
  const owner_email          = villa.owner_email || '';

  // Izračun noći
  const checkInDate  = new Date(check_in);
  const checkOutDate = new Date(check_out);
  const nights = Math.round((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));

  if (nights <= 0) {
    return new Response(JSON.stringify({ error: 'Neispravni datumi' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Izračun iznosa
  const tourist_tax  = (guests || 1) * nights * 2;
  const subtotal     = price_per_night * nights;
  const fee_amount   = Math.round(subtotal * 0.07 * 100) / 100;
  const total_amount = Math.round((subtotal + cleaning_fee + tourist_tax + fee_amount) * 100) / 100;

  // ── Smart payment split ──
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntilCheckIn = Math.round((checkInDate - today) / (1000 * 60 * 60 * 24));

  let deposit_amount, balance_amount, balance_charge_date, payment_type;

  if (daysUntilCheckIn <= payment_policy_days) {
    // Booking unutar perioda → 100% odmah
    deposit_amount     = total_amount;
    balance_amount     = 0;
    balance_charge_date = null;
    payment_type       = 'full';
  } else {
    // Normalno → 40% odmah, 60% X dana prije check-in
    deposit_amount      = Math.round(total_amount * 0.40 * 100) / 100;
    balance_amount      = Math.round((total_amount - deposit_amount) * 100) / 100;
    const balanceDate   = new Date(checkInDate);
    balanceDate.setDate(balanceDate.getDate() - payment_policy_days);
    balance_charge_date = balanceDate.toISOString().split('T')[0];
    payment_type        = 'split';
  }

  // Provjeri dostupnost
  const blocked = await env.DB.prepare(`
    SELECT date FROM availability 
    WHERE villa_id = ? AND status != 'available'
    AND date >= ? AND date < ?
  `).bind(villa_id, check_in, check_out).all();

  if (blocked.results.length > 0) {
    return new Response(JSON.stringify({
      error: 'Vila nije dostupna u odabranom terminu'
    }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Stripe - kreiraj Customer
  const customerRes = await stripeRequest(env.STRIPE_SECRET_KEY, 'POST', '/v1/customers', {
    name: guest_name,
    email: guest_email,
    phone: guest_phone || '',
    'metadata[villa_id]': villa_id,
    'metadata[villa_name]': villa_name
  });

  if (customerRes.error) {
    return new Response(JSON.stringify({ error: 'Stripe greška: ' + customerRes.error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Stripe - kreiraj PaymentIntent
  const piParams = {
    amount: Math.round(deposit_amount * 100),
    currency: 'eur',
    customer: customerRes.id,
    'metadata[villa_id]': villa_id,
    'metadata[villa_name]': villa_name,
    'metadata[check_in]': check_in,
    'metadata[check_out]': check_out,
    'metadata[guest_email]': guest_email,
    'metadata[payment_type]': payment_type,
    description: `${villa_name} - ${payment_type === 'full' ? '100%' : 'depozit 40%'} (${check_in} do ${check_out})`
  };

  // Ako je split — sačuvaj karticu za auto naplatu 60%
  if (payment_type === 'split') {
    piParams['metadata[booking_type]'] = 'deposit_40';
    piParams['setup_future_usage'] = 'off_session';
  } else {
    piParams['metadata[booking_type]'] = 'full_payment';
  }

  const piRes = await stripeRequest(env.STRIPE_SECRET_KEY, 'POST', '/v1/payment_intents', piParams);

  if (piRes.error) {
    return new Response(JSON.stringify({ error: 'Stripe greška: ' + piRes.error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Spremi booking u D1
  const booking_id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO bookings (
      id, villa_id, villa_name, guest_name, guest_email, guest_phone,
      check_in, check_out, guests, nights, price_per_night,
      total_amount, deposit_amount, balance_amount,
      balance_charge_date, status, stripe_customer_id, stripe_pi_deposit, owner_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(
    booking_id, villa_id, villa_name, guest_name, guest_email, guest_phone || '',
    check_in, check_out, guests || 1, nights, price_per_night,
    total_amount, deposit_amount, balance_amount,
    balance_charge_date, customerRes.id, piRes.id, owner_email
  ).run();

  // Vrati podatke frontendu
  return new Response(JSON.stringify({
    booking_id,
    client_secret: piRes.client_secret,
    payment_type,
    breakdown: {
      nights,
      price_per_night,
      cleaning_fee,
      tourist_tax,
      fee_amount,
      total_amount,
      deposit_amount,
      balance_amount,
      balance_charge_date,
      payment_policy_days,
      days_until_checkin: daysUntilCheckIn
    }
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
async function handleWebhook(request, env) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (env.STRIPE_WEBHOOK_SECRET) {
    const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      return new Response('Invalid signature', { status: 400 });
    }
  }

  const event = JSON.parse(body);

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;

    if (pi.metadata && (pi.metadata.booking_type === 'deposit_40' || pi.metadata.booking_type === 'full_payment')) {
      const pm_id = pi.payment_method;

      await env.DB.prepare(`
        UPDATE bookings 
        SET status = 'confirmed', stripe_pm_id = ?
        WHERE stripe_pi_deposit = ?
      `).bind(pm_id, pi.id).run();

      const booking = await env.DB.prepare(`
        SELECT * FROM bookings WHERE stripe_pi_deposit = ?
      `).bind(pi.id).first();

      if (booking) {
        await blockDates(booking.villa_id, booking.check_in, booking.check_out, booking.id, env);
        await sendConfirmationEmails(booking, env);
      }
    }

    if (pi.metadata && pi.metadata.booking_type === 'balance_60') {
      await env.DB.prepare(`
        UPDATE bookings SET status = 'fully_paid'
        WHERE stripe_pi_balance = ?
      `).bind(pi.id).run();

      const booking = await env.DB.prepare(`
        SELECT * FROM bookings WHERE stripe_pi_balance = ?
      `).bind(pi.id).first();

      if (booking) await sendBalancePaidEmail(booking, env);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;

    if (pi.metadata && pi.metadata.booking_type === 'balance_60') {
      const booking = await env.DB.prepare(`
        SELECT * FROM bookings WHERE stripe_pi_balance = ?
      `).bind(pi.id).first();

      if (booking) await sendPaymentFailedEmail(booking, env);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ─── AUTOMATSKA NAPLATA 60% (CRON) ───────────────────────────────────────────
async function chargeBalances(env) {
  const today = new Date().toISOString().split('T')[0];

  const bookings = await env.DB.prepare(`
    SELECT * FROM bookings 
    WHERE balance_charge_date = ? 
    AND status = 'confirmed'
    AND balance_amount > 0
    AND stripe_pm_id IS NOT NULL
  `).bind(today).all();

  for (const booking of bookings.results) {
    try {
      const piRes = await stripeRequest(env.STRIPE_SECRET_KEY, 'POST', '/v1/payment_intents', {
        amount: Math.round(booking.balance_amount * 100),
        currency: 'eur',
        customer: booking.stripe_customer_id,
        payment_method: booking.stripe_pm_id,
        confirm: 'true',
        off_session: 'true',
        'metadata[booking_type]': 'balance_60',
        'metadata[villa_id]': booking.villa_id,
        'metadata[villa_name]': booking.villa_name,
        'metadata[check_in]': booking.check_in,
        'metadata[guest_email]': booking.guest_email,
        description: `${booking.villa_name} - ostatak 60% (${booking.check_in})`
      });

      if (!piRes.error) {
        await env.DB.prepare(`
          UPDATE bookings SET stripe_pi_balance = ? WHERE id = ?
        `).bind(piRes.id, booking.id).run();
      }

    } catch (err) {
      console.error(`Greška pri naplati 60% za booking ${booking.id}:`, err);
    }
  }
}

// ─── BLOKIRANJE DATUMA ────────────────────────────────────────────────────────
async function blockDates(villa_id, check_in, check_out, booking_id, env) {
  const start = new Date(check_in);
  const end = new Date(check_out);
  const statements = [];

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    statements.push(
      env.DB.prepare(`
        INSERT OR REPLACE INTO availability (villa_id, date, status, booking_id)
        VALUES (?, ?, 'booked', ?)
      `).bind(villa_id, dateStr, booking_id)
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

// ─── DOSTUPNOST ───────────────────────────────────────────────────────────────
async function getAvailability(villa_id, env) {
  const result = await env.DB.prepare(`
    SELECT date, status FROM availability
    WHERE villa_id = ? AND date >= date('now')
    ORDER BY date
  `).bind(villa_id).all();

  return new Response(JSON.stringify(result.results), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// ─── OTKAZIVANJE ──────────────────────────────────────────────────────────────
async function cancelBooking(request, env) {
  const { booking_id } = await request.json();

  const booking = await env.DB.prepare(`
    SELECT * FROM bookings WHERE id = ?
  `).bind(booking_id).first();

  if (!booking) {
    return new Response(JSON.stringify({ error: 'Booking nije pronađen' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const checkIn = new Date(booking.check_in);
  const today = new Date();
  const daysUntilCheckIn = Math.round((checkIn - today) / (1000 * 60 * 60 * 24));

  let refundAmount = 0;
  let refundPolicy = '';

  if (daysUntilCheckIn >= 30) {
    refundAmount = booking.deposit_amount;
    refundPolicy = 'Puni refund depozita';
  } else if (daysUntilCheckIn >= 14) {
    refundAmount = Math.round(booking.deposit_amount * 0.5 * 100) / 100;
    refundPolicy = '50% refund depozita';
  } else {
    refundAmount = 0;
    refundPolicy = 'Nema refunda (manje od 14 dana)';
  }

  if (refundAmount > 0 && booking.stripe_pi_deposit) {
    await stripeRequest(env.STRIPE_SECRET_KEY, 'POST', '/v1/refunds', {
      payment_intent: booking.stripe_pi_deposit,
      amount: Math.round(refundAmount * 100)
    });
  }

  await env.DB.prepare(`
    UPDATE availability SET status = 'available', booking_id = NULL
    WHERE booking_id = ?
  `).bind(booking_id).run();

  await env.DB.prepare(`
    UPDATE bookings SET status = 'cancelled' WHERE id = ?
  `).bind(booking_id).run();

  return new Response(JSON.stringify({
    success: true,
    refund_amount: refundAmount,
    refund_policy: refundPolicy,
    days_until_checkin: daysUntilCheckIn
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// ─── DOHVAT BOOKINGA ──────────────────────────────────────────────────────────
async function getBooking(booking_id, env) {
  const booking = await env.DB.prepare(`
    SELECT * FROM bookings WHERE id = ?
  `).bind(booking_id).first();

  if (!booking) {
    return new Response(JSON.stringify({ error: 'Booking nije pronađen' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify(booking), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// ─── STRIPE HELPER ────────────────────────────────────────────────────────────
async function stripeRequest(secretKey, method, endpoint, data = {}) {
  const body = method === 'POST'
    ? new URLSearchParams(data).toString()
    : null;

  const res = await fetch(`https://api.stripe.com${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  return await res.json();
}

// ─── STRIPE WEBHOOK VERIFIKACIJA ─────────────────────────────────────────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(',');
    let timestamp = '';
    let signature = '';

    for (const part of parts) {
      if (part.startsWith('t=')) timestamp = part.slice(2);
      if (part.startsWith('v1=')) signature = part.slice(3);
    }

    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return expected === signature;
  } catch {
    return false;
  }
}

// ─── EMAILOVI ─────────────────────────────────────────────────────────────────
async function sendEmail(apiKey, { to, subject, html }) {
  if (!apiKey) return;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Croatia Premium Stay <noreply@croatiapremiumstay.com>',
      to,
      subject,
      html
    })
  });
}

async function sendConfirmationEmails(booking, env) {
  const paymentNote = booking.balance_amount > 0
    ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Ostatak (60%):</b></td><td style="padding:8px;border-bottom:1px solid #eee;">€${booking.balance_amount} — naplaćuje se automatski ${booking.balance_charge_date}</td></tr>`
    : `<tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Plaćanje:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">Cjelokupni iznos plaćen</td></tr>`;

  await sendEmail(env.RESEND_API_KEY, {
    to: booking.guest_email,
    subject: `✅ Rezervacija potvrđena — ${booking.villa_name}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#0A2535;">Hvala, ${booking.guest_name}!</h2>
        <p>Vaša rezervacija je potvrđena.</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Vila:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.villa_name}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Check-in:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.check_in}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Check-out:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.check_out}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Noći:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.nights}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Ukupno:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">€${booking.total_amount}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Plaćeno danas:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">€${booking.deposit_amount}</td></tr>
          ${paymentNote}
        </table>
        <p style="color:#666;font-size:12px;">Booking ID: ${booking.id}</p>
        <p style="color:#666;">Croatia Premium Stay</p>
      </div>
    `
  });

  if (booking.owner_email) {
    await sendEmail(env.RESEND_API_KEY, {
      to: booking.owner_email,
      subject: `🏠 Nova rezervacija — ${booking.villa_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#0A2535;">Nova rezervacija!</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Gost:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.guest_name}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Email:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.guest_email}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Vila:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.villa_name}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Check-in:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.check_in}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Check-out:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.check_out}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Gosti:</b></td><td style="padding:8px;border-bottom:1px solid #eee;">${booking.guests}</td></tr>
            <tr><td style="padding:8px;"><b>Ukupno:</b></td><td style="padding:8px;">€${booking.total_amount}</td></tr>
          </table>
        </div>
      `
    });
  }
}

async function sendBalancePaidEmail(booking, env) {
  await sendEmail(env.RESEND_API_KEY, {
    to: booking.guest_email,
    subject: `✅ Druga rata plaćena — ${booking.villa_name}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#0A2535;">Druga rata plaćena!</h2>
        <p>Hej ${booking.guest_name}, druga rata od <b>€${booking.balance_amount}</b> je uspješno naplaćena.</p>
        <p>Vidimo se <b>${booking.check_in}</b>!</p>
        <p style="color:#666;">Croatia Premium Stay</p>
      </div>
    `
  });
}

async function sendPaymentFailedEmail(booking, env) {
  await sendEmail(env.RESEND_API_KEY, {
    to: booking.guest_email,
    subject: `⚠️ Naplata nije uspjela — ${booking.villa_name}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#EF4444;">Naplata nije uspjela</h2>
        <p>Hej ${booking.guest_name}, naplata druge rate od <b>€${booking.balance_amount}</b> za <b>${booking.villa_name}</b> nije uspjela.</p>
        <p>Molimo ažurirajte podatke kartice što prije kako biste zadržali rezervaciju.</p>
        <p>Check-in datum: <b>${booking.check_in}</b></p>
        <p style="color:#666;">Croatia Premium Stay</p>
      </div>
    `
  });
}
