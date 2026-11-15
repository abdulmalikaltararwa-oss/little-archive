// The first-launch screens: choose a server, connect, sign in. They are drawn by native.css with the React interface's design
// tokens (ui/DESIGN.md), so they look like the rest of the app and nothing changes style at sign-in.
//
// Form practice: one <form> per screen with real labels; type, autocomplete, inputmode and enterkeyhint set so the
// keyboard and password managers behave (an email is autocomplete="username", a sign-in password "current-password", a
// new one "new-password"); required fields; no double entry of a password, and a show-password toggle; an error is shown
// as text with an icon, announced once through a live region, tied to its field with aria-invalid and aria-describedby
// only while it applies, and focus moves to the first field that needs attention.

export const BACK = Symbol('back');

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
// The Apple logo, for the Sign in with Apple button (white: the button is black, or in the dark theme the logo turns black).
const APPLE_LOGO = [{ box: '0 0 24 24', fill: 'currentColor', d: 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701' }];
// Google's "G", in its four colours, as Google publishes it. The colours are the brand's, so they do not follow the theme.
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

  function frame(...content) {
    root.replaceChildren(h('main', { class: 'native-screen', id: 'main' },
      h('div', { class: 'native-brand' }, h('img', { src: iconUrl, alt: '', width: 38, height: 38 }), h('span', {}, 'little archive')),
      ...content));
    document.title = 'Little Archive';
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

  // A form that runs `submit` and either moves on (it returns) or shows an AppError beside the field it names.
  function form({ fields, submitLabel, busyLabel, submit, extra = [] }) {
    const general = h('div', { class: 'native-error native-error-general', role: 'alert', hidden: true }, h('span', { role: 'img', 'aria-label': 'Error' }, '⚠'), h('span', { class: 'native-error-text' }));
    const button = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
    const node = h('form', { novalidate: true, onSubmit: async event => {
      event.preventDefault();
      general.hidden = true;
      for (const f of Object.values(fields)) f.clear();
      // Native validation decides what is missing; focus goes to the first field that needs attention.
      const missing = Object.values(fields).find(f => !f.control.checkValidity());
      if (missing) { missing.show(missing.control.validationMessage || 'This is needed.'); live.textContent = ''; setTimeout(() => { live.textContent = missing.control.validationMessage; }, 50); missing.control.focus(); return; }
      button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = busyLabel;
      try {
        await submit(Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.control.value])));
        for (const f of Object.values(fields)) if (f.control.dataset.secret) f.control.value = ''; // a password does not linger in the page
      } catch (error) {
        const target = fields[error?.field];
        const message = error?.message || 'Something went wrong. Try again.';
        if (target) { target.show(message); target.control.focus(); }
        else { general.querySelector('.native-error-text').textContent = message; general.hidden = false; general.scrollIntoView({ block: 'nearest' }); }
      } finally { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = submitLabel; }
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

    /** Own server, step one. `submit(addressText)` checks it; the screen resolves with what it returns. */
    server({ value = '', submit }) {
      return new Promise(done => {
        const address = field({ label: 'Server address', name: 'server', type: 'url', inputmode: 'url', autocomplete: 'url', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', required: true, placeholder: 'https://archive.example.com', value, hint: 'The address you open Little Archive at in a browser. It must start with https://.' });
        frame(
          h('p', { class: 'native-whisper' }, 'your own server'),
          h('h1', {}, 'Connect to your server'),
          form({ fields: { server: address }, submitLabel: 'Connect', busyLabel: 'Connecting…', submit: async values => { done(await submit(values.server)); }, extra: [backButton(done)] }));
        address.control.focus();
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
     * `providers` ({apple, google}, both booleans) says which "Continue with" buttons to draw above the email form, and `social(name)`
     * runs one: it returns what a sign-in returns, or null when the person closed the sheet (nothing is said then).
     */
    account({ mode = 'in', host, notice, signIn, signUp, providers = {}, social }) {
      return new Promise(done => {
        let creating = mode === 'up';
        const render = (message = notice, { focus = true } = {}) => {
          const email = field({ label: 'Email', name: 'email', type: 'email', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', required: true });
          const password = passwordField({ label: 'Password', name: 'password', autocomplete: creating ? 'new-password' : 'current-password', enterkeyhint: 'go', minlength: creating ? 8 : null, hint: creating ? 'At least 8 characters. A password manager can make and keep one for you.' : undefined });
          const tabs = h('div', { class: 'native-tabs', role: 'group', 'aria-label': 'Sign in or create an account' },
            ...[[false, 'Sign in'], [true, 'Create account']].map(([isCreate, label]) => h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(creating === isCreate), onClick: () => { if (creating !== isCreate) { creating = isCreate; render(undefined, { focus: false }); } } }, label)));
          const names = ['apple', 'google'].filter(name => providers[name] && social);
          const providerError = h('div', { class: 'native-error native-error-general', role: 'alert', hidden: true }, h('span', { role: 'img', 'aria-label': 'Error' }, '⚠'), h('span', { class: 'native-error-text' }));
          // While a sheet is open nothing else on the screen can be pressed, so one attempt cannot start another.
          const lock = on => root.querySelectorAll('.native-screen button, .native-screen input').forEach(node => { node.disabled = on; });
          const brand = {
            apple: { label: 'Continue with Apple', busy: 'Opening Apple…', logo: icon(20, ...APPLE_LOGO) },
            google: { label: 'Continue with Google', busy: 'Opening Google…', logo: icon(20, ...GOOGLE_LOGO) },
          };
          const providerButton = name => {
            const text = h('span', {}, brand[name].label);
            const button = h('button', { type: 'button', class: `native-social native-social-${name}`, onClick: async () => {
              providerError.hidden = true;
              lock(true); button.setAttribute('aria-busy', 'true'); text.textContent = brand[name].busy;
              try {
                const result = await social(name);
                if (result) { done(result); return; }
              } catch (error) {
                providerError.querySelector('.native-error-text').textContent = error?.message || 'Something went wrong. Try again.';
                providerError.hidden = false;
                providerError.scrollIntoView({ block: 'nearest' });
              }
              // Closed or failed: the screen is usable again, and focus (lost when the button was disabled) comes back to it.
              lock(false); button.removeAttribute('aria-busy'); text.textContent = brand[name].label; button.focus();
            } }, brand[name].logo, text);
            return button;
          };
          frame(
            h('p', { class: 'native-whisper' }, 'a little archive account'),
            h('h1', {}, creating ? 'Create your account' : 'Welcome back'),
            h('p', { class: 'native-lede' }, creating ? 'Your library is private to you.' : `Sign in to your account on ${host}.`),
            message && h('div', { class: 'notice', role: 'status' }, message),
            names.length > 0 && h('div', { class: 'native-socials' }, ...names.map(providerButton), providerError, h('p', { class: 'native-divider' }, h('span', {}, 'or use your email'))),
            tabs,
            form({ fields: { email, password }, submitLabel: creating ? 'Create account' : 'Sign in', busyLabel: creating ? 'Creating…' : 'Signing in…', submit: async values => {
              providerError.hidden = true;
              const result = await (creating ? signUp : signIn)(values.email.trim(), values.password);
              if (result?.confirmationSent) { creating = false; render(`We sent a message to ${values.email.trim()}. Open it to confirm your email, then sign in here.`); return; }
              done(result);
            }, extra: [backButton(done)] }));
          // With the "Continue with" buttons showing, the keyboard stays down until the person goes to the email field: it would cover them.
          if (focus && names.length === 0) email.control.focus();
        };
        render(undefined, { focus: true });
      });
    },

    /** A problem with choices: `actions` is [{label, value, primary?}] and the screen resolves with the chosen value. */
    problem({ title, message, actions }) {
      return new Promise(done => {
        frame(h('h1', {}, title), h('p', { class: 'native-lede', role: 'alert' }, message),
          h('div', { class: 'native-actions' }, actions.map(action => h('button', { type: 'button', class: `btn ${action.primary ? 'primary' : 'ghost'}`, onClick: () => done(action.value) }, action.label))));
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

    announce(text) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 50); },
  };
}
