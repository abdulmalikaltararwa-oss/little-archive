// The first-launch screens: choose a server, connect, sign in. They use the interface's own stylesheet (styles.css) and its
// tokens, so they look like the rest of the app, plus a few rules for the app only (native.css).
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
          h('h1', {}, 'Sign in'),
          h('p', { class: 'native-lede' }, `Connected to ${host}.`),
          notice && h('div', { class: 'notice', role: 'status' }, notice),
          form({ fields: { password }, submitLabel: 'Sign in', busyLabel: 'Signing in…', submit: async values => { done(await submit(values.password)); }, extra: [
            h('p', { class: 'field-help native-fineprint' }, `Your password is sent to ${host} once, to set this phone up. The app keeps only an access token that you can revoke from the server, never the password.`),
            backButton(done, 'Use a different server')] }));
        password.control.focus();
      });
    },

    /** A Little Archive account: sign in or create one. `signIn` and `signUp` return when it worked. */
    account({ mode = 'in', host, notice, signIn, signUp }) {
      return new Promise(done => {
        let creating = mode === 'up';
        const render = (message = notice) => {
          const email = field({ label: 'Email', name: 'email', type: 'email', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', required: true });
          const password = passwordField({ label: 'Password', name: 'password', autocomplete: creating ? 'new-password' : 'current-password', enterkeyhint: 'go', minlength: creating ? 8 : null, hint: creating ? 'At least 8 characters. A password manager can make and keep one for you.' : undefined });
          const tabs = h('div', { class: 'native-tabs', role: 'group', 'aria-label': 'Sign in or create an account' },
            ...[[false, 'Sign in'], [true, 'Create account']].map(([isCreate, label]) => h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(creating === isCreate), onClick: () => { if (creating !== isCreate) { creating = isCreate; render(); } } }, label)));
          frame(
            h('h1', {}, creating ? 'Create your account' : 'Welcome back'),
            h('p', { class: 'native-lede' }, creating ? 'Your library is private to you.' : `Sign in to your account on ${host}.`),
            tabs,
            message && h('div', { class: 'notice', role: 'status' }, message),
            form({ fields: { email, password }, submitLabel: creating ? 'Create account' : 'Sign in', busyLabel: creating ? 'Creating…' : 'Signing in…', submit: async values => {
              const result = await (creating ? signUp : signIn)(values.email.trim(), values.password);
              if (result?.confirmationSent) { creating = false; render(`We sent a message to ${values.email.trim()}. Open it to confirm your email, then sign in here.`); return; }
              done(result);
            }, extra: [backButton(done)] }));
          email.control.focus();
        };
        render();
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
