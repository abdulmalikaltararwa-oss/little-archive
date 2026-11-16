// The first-launch screens: choose a server, connect, sign in. They are drawn by native.css with the React interface's design
// tokens (ui/DESIGN.md), so they look like the rest of the app and nothing changes style at sign-in.
//
// Form practice: one <form> per screen with real labels; type, autocomplete, inputmode and enterkeyhint set so the
// keyboard and password managers behave (an email is autocomplete="username", a sign-in password "current-password", a
// new one "new-password"); required fields; a show-password toggle, and no double entry of a password except where a typing
// slip would lock the person out again (choosing a new password after a reset); an error is shown
// as text with an icon, announced once through a live region, tied to its field with aria-invalid and aria-describedby
// only while it applies, and focus moves to the first field that needs attention.
//
// Focus (ui/DESIGN.md: it never falls to <body>). When a screen is redrawn or a pressed button is disabled, focus is put
// somewhere on purpose: the heading or the notice of the new view, or back on the button when its action ends. The focus ring
// is for the keyboard, so a control that is focused by script after a touch is focused quietly (no ring; see focusQuietly).

export const BACK = Symbol('back');

// The guide for running a server of your own. The project publishes its guides in its public repository (README.md), so this
// is that repository's address with the guide's path; the app has no other documentation site.
export const SELF_HOSTING_GUIDE = 'https://github.com/abdulmalikaltararwa-oss/little-archive/blob/main/docs/self-hosting.md';

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';
/** An inline SVG icon (the h() helper above makes HTML elements only). Decorative: the button's own text is its name. */
function icon(size, ...paths) {
  const node = document.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries({ viewBox: paths[0].box, width: size, height: size, 'aria-hidden': 'true', focusable: 'false' })) node.setAttribute(name, String(value));
  for (const { d, fill } of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    if (fill) path.setAttribute('fill', fill);
    node.append(path);
  }
  return node;
}
// An Apple mark for the "Continue with Apple" button (white: the button is black, or in the dark theme the logo turns black).
// It is a path drawn here, not the logo artwork Apple supplies for Sign in with Apple buttons (see native.css and the guide's risks).
// The path fills the box's height and about 17 of its 24 units of width; the button draws it 16px high (a third of its height).
const APPLE_LOGO = [{ box: '0 0 24 24', fill: 'currentColor', d: 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701' }];
// Google's "G" in its four colours. The colours are the brand's, so they do not follow the theme.
const GOOGLE_LOGO = [
  { box: '0 0 48 48', fill: '#EA4335', d: 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z' },
  { box: '0 0 48 48', fill: '#4285F4', d: 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z' },
  { box: '0 0 48 48', fill: '#FBBC05', d: 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z' },
  { box: '0 0 48 48', fill: '#34A853', d: 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z' },
];

let ids = 0;
const nextId = prefix => `${prefix}-${++ids}`;

export function createUi(root, { iconUrl = '/icon.svg' } = {}) {
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  document.body.append(live);

  /** Say something once to a screen reader, through the live region. */
  const announce = text => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 50); };

  // Was the last thing the person did a touch (or a click), or a key? Decides whether a focus the page moves shows its ring.
  let touched = false;
  document.addEventListener('pointerdown', () => { touched = true; }, true);
  document.addEventListener('keydown', () => { touched = false; }, true);

  // The app ends the web view at the keyboard, so the page changes size when the keyboard comes up, changes height or the phone
  // is turned. The web view shows a field when it takes focus, not after a later change of size, so keep the field that is being
  // typed in on screen: when the change leaves it out of view, it goes to the middle of what is left. A field that is still in view
  // is left alone. This stays for the interface too, once it has replaced these screens. The visual viewport's own event is
  // listened to as well: in an Android emulator (WebView 133) a field focused under the keyboard came into view with it and not
  // without it (one run each).
  const showField = () => {
    const field = document.activeElement;
    if (!field?.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const page = document.defaultView;
    const top = page.visualViewport?.offsetTop ?? 0;
    const height = page.visualViewport?.height ?? page.innerHeight;
    const box = field.getBoundingClientRect();
    if (box.top < top || box.bottom > top + height) field.scrollIntoView({ block: 'center' });
  };
  document.defaultView?.addEventListener('resize', showField);
  document.defaultView?.visualViewport?.addEventListener('resize', showField);

  /** Focus a control from script. After a touch it gets no focus ring (native.css, .native-quiet), until focus next leaves it. */
  function focusQuietly(node) {
    if (!node?.isConnected) return;
    if (touched) {
      node.classList.add('native-quiet');
      node.addEventListener('blur', () => node.classList.remove('native-quiet'), { once: true });
    }
    node.focus();
  }
  /** A heading or a notice that takes focus when its view appears, so a screen reader starts there. It is not a tab stop. */
  function landing(node) { node.setAttribute('tabindex', '-1'); return node; }
  const focusLost = () => !document.activeElement || document.activeElement === document.body || !root.contains(document.activeElement);

  /**
   * One action at a time on a screen. While it is held every button on the screen is disabled, and the handlers check `held`
   * as well (Return in a field submits a form without touching a button). Text fields are left alone: disabling the one being
   * typed in would drop focus and the keyboard. `seal` holds it for good, once the screen has given its answer.
   *
   * The lock belongs to the view it was last given (`over`, the node frame() returns), and touches only that view's buttons while
   * it is on the page. A screen can be replaced while something of its is still on its way (a reset link opening the app,
   * onboarding.js); when that answer comes, it must not disable or enable the buttons of the screen that took its place.
   */
  function createLock() {
    let held = false;
    let sealed = false;
    let view = null;
    const apply = () => { if (view?.isConnected) view.querySelectorAll('button').forEach(button => { button.disabled = held; }); };
    return {
      get held() { return held; },
      over(node) { view = node; apply(); },
      set(on) { if (sealed) return; held = on; apply(); },
      seal() { sealed = true; held = true; apply(); },
    };
  }

  /** Draws a screen in place of whatever was there, and returns its node. */
  function frame(...content) {
    const view = h('main', { class: 'native-screen', id: 'main' },
      h('div', { class: 'native-brand' }, h('img', { src: iconUrl, alt: '', width: 38, height: 38 }), h('span', {}, 'little archive')),
      ...content);
    root.replaceChildren(view);
    document.title = 'Little Archive';
    return view;
  }

  // An input with its label, hint and error. The error is linked to the field only while it is showing.
  function field({ label, hint, name, ...input }) {
    const id = nextId('native-field');
    const hintId = hint ? `${id}-hint` : '';
    const errorId = `${id}-error`;
    const control = h('input', { id, name, 'aria-invalid': 'false', ...(hintId ? { 'aria-describedby': hintId } : {}), ...input });
    const error = h('div', { class: 'native-error', id: errorId, hidden: true }, h('span', { role: 'img', 'aria-label': 'Error' }, '⚠'), h('span', { class: 'native-error-text' }));
    const wrap = h('div', { class: 'form-field' }, h('label', { for: id }, label), hint && h('p', { class: 'field-help', id: hintId }, hint), control, error);
    return {
      wrap, control,
      show(message) {
        error.querySelector('.native-error-text').textContent = message;
        error.hidden = false;
        control.setAttribute('aria-invalid', 'true');
        control.setAttribute('aria-describedby', [hintId, errorId].filter(Boolean).join(' '));
      },
      clear() {
        error.hidden = true;
        control.setAttribute('aria-invalid', 'false');
        if (hintId) control.setAttribute('aria-describedby', hintId); else control.removeAttribute('aria-describedby');
      },
    };
  }

  function passwordField(options) {
    const f = field({ ...options, type: 'password', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true });
    f.control.dataset.secret = 'true';
    const toggle = h('button', { type: 'button', class: 'btn ghost small native-reveal', 'aria-pressed': 'false', onClick: () => {
      const shown = f.control.type === 'text';
      f.control.type = shown ? 'password' : 'text';
      toggle.textContent = shown ? 'Show password' : 'Hide password';
      toggle.setAttribute('aria-pressed', String(!shown));
    } }, 'Show password');
    f.wrap.append(toggle);
    return f;
  }

  // A form that runs `submit` and either moves on (it returns) or shows an AppError beside the field it names. `lock` is the
  // screen's lock when the screen has other actions that must not run at the same time (the account screen); without one the
  // form only keeps its own button from being pressed twice.
  function form({ fields, submitLabel, busyLabel, submit, extra = [], lock }) {
    const general = h('div', { class: 'native-error native-error-general', role: 'alert', hidden: true }, h('span', { role: 'img', 'aria-label': 'Error' }, '⚠'), h('span', { class: 'native-error-text' }));
    const button = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
    let running = false;
    const node = h('form', { novalidate: true, onSubmit: async event => {
      event.preventDefault();
      if (running || lock?.held) return;
      general.hidden = true;
      for (const f of Object.values(fields)) f.clear();
      // Native validation decides what is missing; focus goes to the first field that needs attention.
      const missing = Object.values(fields).find(f => !f.control.checkValidity());
      if (missing) { missing.show(missing.control.validationMessage || 'This is needed.'); live.textContent = ''; setTimeout(() => { live.textContent = missing.control.validationMessage; }, 50); missing.control.focus(); return; }
      running = true;
      if (lock) lock.set(true); else button.disabled = true;
      button.setAttribute('aria-busy', 'true'); button.textContent = busyLabel;
      let target;
      try {
        await submit(Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.control.value])));
        for (const f of Object.values(fields)) if (f.control.dataset.secret) f.control.value = ''; // a password does not linger in the page
      } catch (error) {
        target = fields[error?.field];
        const message = error?.message || 'Something went wrong. Try again.';
        if (target) target.show(message);
        else { general.querySelector('.native-error-text').textContent = message; general.hidden = false; general.scrollIntoView({ block: 'nearest' }); }
      } finally {
        running = false;
        if (lock) lock.set(false); else button.disabled = false;
        button.removeAttribute('aria-busy'); button.textContent = submitLabel;
      }
      // Still this screen (it may have moved on or been redrawn): the field that was wrong takes focus, and if focus was on the
      // button, which lost it when it was disabled, it goes back there.
      if (!node.isConnected) return;
      if (target) target.control.focus();
      else if (focusLost() && !button.disabled) focusQuietly(button);
    } }, general, ...Object.values(fields).map(f => f.wrap), button, ...extra);
    return node;
  }

  const backButton = (done, label = 'Back') => h('button', { type: 'button', class: 'btn ghost', onClick: () => done(BACK) }, label);

  return {
    /** The first question: where does the library live? Resolves with 'hosted' or 'own'. */
    choose({ notice } = {}) {
      return new Promise(done => {
        const option = (value, title, text) => h('button', { type: 'button', class: 'native-choice', onClick: () => done(value) }, h('strong', {}, title), h('span', {}, text));
        frame(
          h('p', { class: 'native-whisper' }, 'welcome home'),
          h('h1', {}, 'Where is your library?'),
          h('p', { class: 'native-lede' }, 'Little Archive keeps what you save in one place you control. Choose where that is.'),
          notice && h('div', { class: 'notice', role: 'status' }, notice),
          h('div', { class: 'native-choices' },
            option('hosted', 'Little Archive account', 'Sign up or sign in. Your library is kept for you.'),
            option('own', 'My own server', 'Connect to a Little Archive that you run yourself.')));
      });
    },

    /**
     * Own server, step one. `submit(addressText)` checks it; the screen resolves with what it returns.
     *
     * Under the form is what someone needs to know before the address can work: the phone has to reach the server, only https is
     * accepted, and where the guide is. The guide opens in the phone's browser (a link with target="_blank" leaves the web view,
     * as "Open original" does in the interface). On arrival focus is on the heading, not the field: the keyboard would cover the
     * guidance, and a screen reader starts at the top of the screen.
     */
    server({ value = '', submit }) {
      return new Promise(done => {
        const address = field({ label: 'Server address', name: 'server', type: 'url', inputmode: 'url', autocomplete: 'url', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', required: true, placeholder: 'https://archive.example.com', value, hint: 'The address you open Little Archive at in a browser, for example https://archive.example.com. It must start with https://.' });
        const guideId = nextId('native-guide');
        const heading = landing(h('h1', {}, 'Connect to your server'));
        frame(
          h('p', { class: 'native-whisper' }, 'your own server'),
          heading,
          h('p', { class: 'native-lede' }, 'Type the address of the Little Archive you run. The app asks it what it is before you enter a password.'),
          form({ fields: { server: address }, submitLabel: 'Connect', busyLabel: 'Connecting…', submit: async values => { done(await submit(values.server)); }, extra: [backButton(done)] }),
          h('section', { class: 'native-guide', 'aria-labelledby': guideId },
            h('h2', { class: 'native-whisper', id: guideId }, 'before you connect'),
            h('ul', {},
              h('li', {}, 'This phone has to be able to reach the server. A public https:// address works from anywhere. An address on your home network works only while the phone is on the same Wi-Fi.'),
              h('li', {}, 'Plain http:// is refused, on a home network too, because your password would travel unencrypted.')),
            h('a', { class: 'native-link', href: SELF_HOSTING_GUIDE, target: '_blank', rel: 'noopener noreferrer' }, 'Self-hosting guide (opens in your browser)')));
        heading.focus();
      });
    },

    /** Own server, step two: the owner password, exchanged once for this phone's access token. */
    password({ host, notice, submit }) {
      return new Promise(done => {
        const password = passwordField({ label: 'Owner password', name: 'password', autocomplete: 'current-password', enterkeyhint: 'go', hint: undefined });
        frame(
          h('p', { class: 'native-whisper' }, 'owner sign-in'),
          h('h1', {}, 'Sign in'),
          h('p', { class: 'native-lede' }, `Connected to ${host}.`),
          notice && h('div', { class: 'notice', role: 'status' }, notice),
          form({ fields: { password }, submitLabel: 'Sign in', busyLabel: 'Signing in…', submit: async values => { done(await submit(values.password)); }, extra: [
            h('p', { class: 'field-help native-fineprint' }, `Your password is sent to ${host} once, to set this phone up. The app keeps only an access token that you can revoke from the server, never the password.`),
            backButton(done, 'Use a different server')] }));
        password.control.focus();
      });
    },

    /**
     * A Little Archive account: sign in or create one. `signIn` and `signUp` return when it worked.
     * `providers` ({apple, google}, both booleans) says which "Continue with" buttons to draw above the email form, and
     * `social(name, onStage)` runs one: it returns what a sign-in returns, or null when the person closed the sheet (nothing is
     * said then). It calls `onStage('signing-in')` when the sheet or the browser is done and the app is asking for the session.
     *
     * One lock for the whole screen: while any sign-in is on its way (a sheet is open, a code is being traded, the email form
     * was sent) the tabs, both "Continue with" buttons, the form's button and Back cannot be pressed and Return does not send
     * the form, so two sign-ins cannot overlap and leave a session that nothing holds. Once the screen has its answer the lock
     * stays, until the app draws the next screen.
     *
     * With `forgot`, the Sign in view has a "Forgot your password?" button under the form. It is under the same lock, and the
     * screen then resolves with `{ forgot: <the email typed so far> }`, for the caller to show the reset screen.
     */
    account({ mode = 'in', host, notice, signIn, signUp, providers = {}, social, forgot = false }) {
      return new Promise(done => {
        let creating = mode === 'up';
        const lock = createLock();
        const finish = value => { lock.seal(); done(value); };
        // `land` says where focus goes once the view is drawn: 'start' (arriving), 'heading' (the other tab) or 'notice'.
        const render = (message = notice, land = 'start') => {
          const email = field({ label: 'Email', name: 'email', type: 'email', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', required: true });
          const password = passwordField({ label: 'Password', name: 'password', autocomplete: creating ? 'new-password' : 'current-password', enterkeyhint: 'go', minlength: creating ? 8 : null, hint: creating ? 'At least 8 characters. A password manager can make and keep one for you.' : undefined });
          const tabs = h('div', { class: 'native-tabs', role: 'group', 'aria-label': 'Sign in or create an account' },
            ...[[false, 'Sign in'], [true, 'Create account']].map(([isCreate, label]) => h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(creating === isCreate), onClick: () => { if (!lock.held && creating !== isCreate) { creating = isCreate; render(undefined, 'heading'); } } }, label)));
          const names = ['apple', 'google'].filter(name => providers[name] && social);
          // Not an alert: like a field's error, it is read as the description of the button that focus returns to.
          const providerError = h('div', { class: 'native-error native-error-general', id: nextId('native-social-error'), hidden: true }, h('span', { role: 'img', 'aria-label': 'Error' }, '⚠'), h('span', { class: 'native-error-text' }));
          const brand = {
            apple: { label: 'Continue with Apple', busy: 'Opening Apple…', logo: icon(16, ...APPLE_LOGO) },
            google: { label: 'Continue with Google', busy: 'Opening Google…', logo: icon(20, ...GOOGLE_LOGO) },
          };
          const buttons = {};
          const clearProviderError = () => { providerError.hidden = true; for (const button of Object.values(buttons)) button.removeAttribute('aria-describedby'); };
          const providerButton = name => {
            const text = h('span', {}, brand[name].label);
            const say = words => { text.textContent = words; announce(words); };
            const button = h('button', { type: 'button', class: `native-social native-social-${name}`, onClick: async () => {
              if (lock.held) return;
              clearProviderError();
              lock.set(true); button.setAttribute('aria-busy', 'true'); say(brand[name].busy);
              try {
                // The sheet or the browser is gone and the session is being fetched: it is no longer "opening" anything.
                const result = await social(name, stage => { if (stage === 'signing-in') say('Signing in…'); });
                if (result) { finish(result); return; }
              } catch (error) {
                providerError.querySelector('.native-error-text').textContent = error?.message || 'Something went wrong. Try again.';
                providerError.hidden = false;
                button.setAttribute('aria-describedby', providerError.id);
                providerError.scrollIntoView({ block: 'nearest' });
              }
              // Closed or failed: the screen is usable again, and focus (lost when the button was disabled) comes back to the button
              // that was pressed, without a focus ring for someone who pressed it with a finger.
              lock.set(false); button.removeAttribute('aria-busy'); text.textContent = brand[name].label;
              focusQuietly(button);
            } }, brand[name].logo, text);
            buttons[name] = button;
            return button;
          };
          const heading = landing(h('h1', {}, creating ? 'Create your account' : 'Welcome back'));
          const said = message && landing(h('div', { class: 'notice', role: 'status' }, message));
          lock.over(frame(
            h('p', { class: 'native-whisper' }, 'a little archive account'),
            heading,
            h('p', { class: 'native-lede' }, creating ? 'A library of your own, kept on your account.' : `Sign in to your account on ${host}.`),
            said,
            names.length > 0 && h('div', { class: 'native-socials' }, ...names.map(providerButton), providerError, h('p', { class: 'native-divider' }, h('span', {}, 'or use your email'))),
            tabs,
            form({ lock, fields: { email, password }, submitLabel: creating ? 'Create account' : 'Sign in', busyLabel: creating ? 'Creating…' : 'Signing in…', submit: async values => {
              clearProviderError();
              const result = await (creating ? signUp : signIn)(values.email.trim(), values.password);
              if (result?.confirmationSent) { creating = false; render(`We sent a message to ${values.email.trim()}. Open it to confirm your email, then sign in here.`, 'notice'); return; }
              finish(result);
            }, extra: [
              forgot && !creating && h('button', { type: 'button', class: 'btn ghost small', onClick: () => { if (!lock.held) finish({ forgot: email.control.value.trim() }); } }, 'Forgot your password?'),
              backButton(finish)] })));
          // The view was redrawn, so whatever had focus is gone. A notice is what the person needs to hear first; after a tab
          // switch it is the new heading. On arrival the email field takes focus only when there are no "Continue with" buttons:
          // with them showing, the keyboard would cover them, so it stays down until the person goes to a field.
          if (said && land !== 'heading') said.focus();
          else if (land === 'start' && names.length === 0) email.control.focus();
          else heading.focus();
        };
        render();
      });
    },

    /**
     * A forgotten password, step one: the email to send a reset link to. `submit(email)` asks for the link and says nothing
     * about the address; the screen resolves with 'sent' when it returns, or BACK. What is said next is the caller's, and is
     * the same for every address.
     */
    forgot({ host, email = '', submit }) {
      return new Promise(done => {
        const address = field({ label: 'Email', name: 'email', type: 'email', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', required: true, value: email });
        const heading = landing(h('h1', {}, 'Reset your password'));
        frame(
          h('p', { class: 'native-whisper' }, 'a little archive account'),
          heading,
          h('p', { class: 'native-lede' }, `Enter the email of your account on ${host}. If it has an account, we send it a link that lets you choose a new password.`),
          form({ fields: { email: address }, submitLabel: 'Send reset link', busyLabel: 'Sending…', submit: async values => { await submit(values.email.trim()); done('sent'); }, extra: [
            h('p', { class: 'field-help native-fineprint' }, 'Signed up with Google or Apple? There is no password to reset: go back and use that button.'),
            backButton(done, 'Back to sign in')] }));
        heading.focus();
      });
    },

    /**
     * A forgotten password, step two, reached from the emailed link: choose the new one. `submit(password)` sets it; the screen
     * resolves with 'saved' when it returns, or BACK for Cancel. The rules are the sign-up form's (8 characters, a show-password
     * toggle on each field); the password is typed twice here, because a slip would lock the person out a second time.
     */
    newPassword({ email = '', submit }) {
      return new Promise(done => {
        const rule = 'At least 8 characters. A password manager can make and keep one for you.';
        const password = passwordField({ label: 'New password', name: 'password', autocomplete: 'new-password', enterkeyhint: 'next', minlength: 8, hint: rule });
        const confirm = passwordField({ label: 'New password, again', name: 'confirm', autocomplete: 'new-password', enterkeyhint: 'go', hint: undefined });
        const heading = landing(h('h1', {}, 'Choose a new password'));
        frame(
          h('p', { class: 'native-whisper' }, 'a little archive account'),
          heading,
          h('p', { class: 'native-lede' }, email ? `For ${email}. When it is saved you are signed in.` : 'When it is saved you are signed in.'),
          form({ fields: { password, confirm }, submitLabel: 'Save password and sign in', busyLabel: 'Saving…', submit: async values => {
            // Checked here as well as by the field: a value a password manager fills in is not always measured by minlength.
            if (values.password.length < 8) throw Object.assign(new Error('Use at least 8 characters.'), { field: 'password' });
            if (values.password !== values.confirm) throw Object.assign(new Error('The two passwords are not the same. Type the new password again.'), { field: 'confirm' });
            await submit(values.password);
            done('saved');
          }, extra: [
            // For a password manager: which account the new password belongs to.
            email && h('input', { type: 'email', name: 'email', autocomplete: 'username', value: email, readonly: true, hidden: true }),
            backButton(done, 'Cancel')] }));
        heading.focus();
      });
    },

    /** A problem with choices: `actions` is [{label, value, primary?}] and the screen resolves with the chosen value. */
    problem({ title, message, actions }) {
      return new Promise(done => {
        const heading = landing(h('h1', {}, title));
        frame(heading, h('p', { class: 'native-lede', role: 'alert' }, message),
          h('div', { class: 'native-actions' }, actions.map(action => h('button', { type: 'button', class: `btn ${action.primary ? 'primary' : 'ghost'}`, onClick: () => done(action.value) }, action.label))));
        heading.focus();
      });
    },

    /** Something the app cannot get past (not running as an app, a bad build). */
    stop(title, message) {
      frame(h('h1', {}, title), h('p', { class: 'native-lede' }, message));
    },

    /** The brief screen while the app checks a saved sign-in. */
    working(message = 'Opening your library…') {
      frame(h('p', { class: 'native-lede', role: 'status' }, message));
    },

    announce,
  };
}
