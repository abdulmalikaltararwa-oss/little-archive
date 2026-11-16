// The pay page of a hosted server: sign in to the Little Archive account, then start the one-time payment at Tap.
//
// The page opens on the offer (what is free, what the unlock adds, the price). Its button leads to the sign-in view; once signed
// in, the same offer shows who is signed in and the Pay button instead.
//
// Sign-in goes straight to the operator's Supabase project with its publishable key (public by design), exactly as the phone app
// does: POST /auth/v1/token?grant_type=password, or Google through the browser with PKCE (GET /auth/v1/authorize, then
// POST /auth/v1/token?grant_type=pkce). The access token is kept in this script's memory only: closing or reloading the page
// forgets it. The one thing stored is the PKCE verifier, in sessionStorage, because it has to outlive the trip to Google; it is
// removed as soon as the page comes back, and it is useless without the code that only this browser receives.
//
// Paying is two requests to this server with that token: GET /api/account (is it unlocked already?) and
// POST /api/purchases/tap/start, whose answer is the address of Tap's page. The amount is the server's; nothing here sets it.
(function () {
  'use strict';

  var main = document.getElementById('main');
  var supabase = main.dataset.supabaseUrl;
  var key = main.dataset.supabaseKey;
  var VERIFIER = 'little-archive-pay-verifier';
  var VIEWS = ['signin', 'offer', 'open', 'done'];
  var token = null;
  var email = '';

  function $(id) { return document.getElementById(id); }

  // `quiet` leaves the keyboard's focus where it is (the first view, when the page has only just loaded).
  function show(name, quiet) {
    VIEWS.forEach(function (view) { $(view).hidden = view !== name; });
    $('signed').hidden = !token;
    $('begin').hidden = !!token;
    $('pay').hidden = !token;
    $('who').textContent = email;
    $('who-done').textContent = email || 'this account';
    if (!quiet) $(name + '-title').focus();
  }

  // The two messages sit under the views, so on a small screen each is brought into sight when it says something.
  function tell(id, text) {
    $(id).textContent = text || '';
    if (text) $(id).scrollIntoView({ block: 'nearest' });
  }

  function say(text) { tell('status', text); }
  function fail(text) { say(''); tell('error', text); }

  function busy(on) {
    main.setAttribute('aria-busy', on ? 'true' : 'false');
    Array.prototype.forEach.call(main.querySelectorAll('button'), function (button) { button.disabled = on; });
  }

  // One request; the answer is {status, body}. A network failure is status 0.
  async function ask(url, method, headers, body) {
    try {
      var reply = await fetch(url, {
        method: method, headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}, headers),
        body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'
      });
      var parsed = null;
      try { parsed = await reply.json(); } catch (error) { parsed = null; }
      return { status: reply.status, body: parsed };
    } catch (error) {
      return { status: 0, body: null };
    }
  }

  function auth(path, body) { return ask(supabase + path, body ? 'POST' : 'GET', { apikey: key }, body); }
  function server(method, path, body) { return ask(path, method, { Authorization: 'Bearer ' + token }, body); }

  function granted(reply) {
    if (reply.status !== 200 || !reply.body || typeof reply.body.access_token !== 'string') return false;
    token = reply.body.access_token;
    email = (reply.body.user && typeof reply.body.user.email === 'string' && reply.body.user.email) || $('email').value.trim();
    $('password').value = '';
    return true;
  }

  function signInProblem(reply) {
    var code = reply.body && (reply.body.error_code || reply.body.code);
    if (reply.status === 0) return 'The sign-in service could not be reached. Check your connection and try again.';
    if (reply.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (code === 'email_not_confirmed') return 'Confirm your email address first: open the link sent when you signed up.';
    if (reply.status === 400 || reply.status === 401 || reply.status === 422) return 'That email and password do not match an account.';
    return 'Sign-in did not work just now. Try again in a moment.';
  }

  // With a message (a sign-in that failed or is no longer valid) the sign-in view; without one (Sign out) the offer again.
  function signedOut(message) {
    token = null;
    email = '';
    show(message ? 'signin' : 'offer');
    fail(message || '');
  }

  // Is the account unlocked already? The server also looks again at a payment that is still open when it answers this.
  async function account(again) {
    fail('');
    say('Checking your account.');
    busy(true);
    var reply = await server('GET', '/api/account');
    busy(false);
    say('');
    if (reply.status === 401) return signedOut('That sign-in is not valid here. Sign in again.');
    if (reply.status === 200 && reply.body && reply.body.entitlements && reply.body.entitlements.unlocked === true) return show('done');
    show('offer');
    if (reply.status !== 200) fail('Your account could not be checked just now. Try again in a moment.');
    else if (again === true) say('No payment has been confirmed yet. If you already paid, wait a minute and check again before paying a second time.');
  }

  async function pay() {
    fail('');
    say('Starting the payment.');
    busy(true);
    var reply = await server('POST', '/api/purchases/tap/start', { email: email });
    busy(false);
    say('');
    var body = reply.body || {};
    if (reply.status === 401) return signedOut('That sign-in is not valid here. Sign in again.');
    if (reply.status === 200 && body.unlocked === true) return show('done');
    if (reply.status === 200 && typeof body.url === 'string' && body.url.indexOf('https://') === 0) {
      say('Taking you to Tap Payments.');
      busy(true);
      window.location.assign(body.url);
      return;
    }
    if (reply.status === 409 && body.code === 'payment_open') return show('open');
    if (reply.status === 503 && body.reason === 'not_configured') return fail('Paying on the web is not switched on for this service yet. Nothing was charged.');
    if (reply.status === 429) return fail('Too many requests. Wait a minute and try again. Nothing was charged.');
    fail('The payment could not be started just now. Nothing was charged. Try again in a moment.');
  }

  async function signIn(event) {
    event.preventDefault();
    var address = $('email');
    var password = $('password');
    var missing = !address.value.trim() ? address : (!password.value ? password : null);
    address.setAttribute('aria-invalid', address.value.trim() ? 'false' : 'true');
    password.setAttribute('aria-invalid', password.value ? 'false' : 'true');
    if (missing) {
      fail(missing === address ? 'Enter your email address.' : 'Enter your password.');
      missing.focus();
      return;
    }
    fail('');
    say('Signing in.');
    busy(true);
    var reply = await auth('/auth/v1/token?grant_type=password', { email: address.value.trim(), password: password.value });
    busy(false);
    say('');
    if (!granted(reply)) return fail(signInProblem(reply));
    account();
  }

  function base64url(bytes) {
    var text = '';
    bytes.forEach(function (byte) { text += String.fromCharCode(byte); });
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function google() {
    fail('');
    var verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    try { sessionStorage.setItem(VERIFIER, verifier); } catch (error) { return fail('This browser will not keep the sign-in going between pages. Use your email and password.'); }
    var query = new URLSearchParams({ provider: 'google', redirect_to: window.location.origin + '/pay', prompt: 'select_account', code_challenge: base64url(digest), code_challenge_method: 's256' });
    window.location.assign(supabase + '/auth/v1/authorize?' + query);
  }

  // Back from Google: the address carries a code (or an error). It is taken off the address bar at once, and traded with the verifier.
  async function comeBack() {
    var query = new URLSearchParams(window.location.search);
    var hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    var code = query.get('code');
    var refused = query.get('error') || query.get('error_code') || hash.get('error') || hash.get('error_code');
    if (window.location.search || window.location.hash) window.history.replaceState(null, '', '/pay');
    var verifier = null;
    try { verifier = sessionStorage.getItem(VERIFIER); sessionStorage.removeItem(VERIFIER); } catch (error) { verifier = null; }
    if (!code && !refused) return false;
    if (!code || !verifier) { signedOut('Google did not finish signing you in. Try again.'); return true; }
    say('Signing in.');
    busy(true);
    var reply = await auth('/auth/v1/token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
    busy(false);
    say('');
    if (!granted(reply)) { signedOut('Google did not finish signing you in. Try again.'); return true; }
    account();
    return true;
  }

  async function offerGoogle() {
    var reply = await auth('/auth/v1/settings');
    if (reply.status === 200 && reply.body && reply.body.external && reply.body.external.google === true && window.crypto && crypto.subtle) $('google').hidden = false;
  }

  $('signin-form').addEventListener('submit', signIn);
  $('google').addEventListener('click', google);
  $('pay').addEventListener('click', pay);
  $('check').addEventListener('click', function () { account(true); });
  $('signout').addEventListener('click', function () { signedOut(''); });
  $('signout-done').addEventListener('click', function () { signedOut(''); });
  $('begin').addEventListener('click', function () { fail(''); show('signin'); });
  $('back').addEventListener('click', function () { fail(''); show('offer'); });

  comeBack().then(function (handled) { if (!handled) show('offer', true); });
  offerGoogle();
})();
