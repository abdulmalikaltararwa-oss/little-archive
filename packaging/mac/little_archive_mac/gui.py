"""The AppKit shell: Dock icon, menu, first-run window and quit handling.

Every decision lives in `core`. This module only draws windows and forwards events, so it
imports macOS frameworks and is exercised by launching the built app, not by unit tests.

Windows are shown without a modal loop. A modal alert would hold back the system's quit
request (Dock > Quit, log out, restart) until it was dismissed.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
import signal

import objc
from AppKit import (
    NSAlert, NSApplication, NSApplicationActivationPolicyRegular, NSFont, NSMenu, NSMenuItem, NSPasteboard,
    NSPasteboardItem, NSPasteboardTypeString, NSTextField, NSWorkspace,
)
from Foundation import (
    NSActivityUserInitiatedAllowingIdleSystemSleep, NSMakeRect, NSObject, NSProcessInfo, NSRunLoop,
    NSRunLoopCommonModes, NSTimer,
)

from . import core

_log = logging.getLogger("little_archive.gui")
_TERMINATE_NOW = 1


def _password_field(password):
    field = NSTextField.alloc().initWithFrame_(NSMakeRect(0, 0, 380, 24))
    field.setStringValue_(password)
    field.setEditable_(False)
    field.setSelectable_(True)
    field.setBezeled_(True)
    field.setFont_(NSFont.monospacedSystemFontOfSize_weight_(13, 0.0))
    return field


def _copy_concealed(text, board=None):
    """Copy to the clipboard and ask clipboard managers that honor the convention not to keep it."""
    board = board or NSPasteboard.generalPasteboard()
    board.clearContents()
    item = NSPasteboardItem.alloc().init()
    item.setString_forType_(text, NSPasteboardTypeString)
    item.setString_forType_("", "org.nspasteboard.ConcealedType")
    board.writeObjects_([item])


def _friendly_path(path):
    home = str(Path.home())
    text = str(path)
    return "~" + text[len(home):] if text == home or text.startswith(home + "/") else text


def _reveal(path):
    NSWorkspace.sharedWorkspace().selectFile_inFileViewerRootedAtPath_(str(path), "")


class _Delegate(NSObject):
    def initWithInstance_(self, instance):
        self = objc.super(_Delegate, self).init()
        if self is None:
            return None
        self.instance = instance
        self.exit_code = 0
        self.started = False
        self.stop_requested = False
        self.shut_down = False
        self.reported_failure = False
        self.ticks_since_terminate = 0
        self.activity = None
        self.open_windows = {}
        return self

    # --- Windows -------------------------------------------------------------------

    @objc.python_method
    def present(self, title, message, buttons, accessory=None, then=None):
        """Show a native alert-style window without blocking. `then(index)` runs when a button is clicked."""
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        alert = NSAlert.alloc().init()
        alert.setMessageText_(title)
        alert.setInformativeText_(message)
        for button in buttons:
            alert.addButtonWithTitle_(button)
        if accessory is not None:
            alert.setAccessoryView_(accessory)
        alert.layout()
        window = alert.window()
        for index, button in enumerate(alert.buttons()):
            button.setTag_(index)
            button.setTarget_(self)
            button.setAction_("alertButton:")
        self.open_windows[window] = (alert, then)
        window.center()
        window.makeKeyAndOrderFront_(None)

    def alertButton_(self, sender):
        window = sender.window()
        _, then = self.open_windows.pop(window, (None, None))
        window.orderOut_(None)
        if then is not None:
            try:
                then(int(sender.tag()))
            except Exception:
                _log.exception("Unexpected failure handling a button.")

    # --- Lifecycle -----------------------------------------------------------------

    def applicationDidFinishLaunching_(self, notification):
        try:
            self._launch()
        except Exception:
            _log.exception("Unexpected failure while starting.")
            self.exit_code = 1
            self.present("Little Archive could not start", "Something unexpected went wrong. Details are in the log.", ["Quit"], then=self._quit)

    @objc.python_method
    def _quit(self, _index=0):
        NSApplication.sharedApplication().terminate_(None)

    @objc.python_method
    def _launch(self):
        app = NSApplication.sharedApplication()
        # The status timer also lets a termination signal take effect while a window is open.
        timer = NSTimer.timerWithTimeInterval_target_selector_userInfo_repeats_(0.5, self, "tick:", None, True)
        NSRunLoop.currentRunLoop().addTimer_forMode_(timer, NSRunLoopCommonModes)
        try:
            self.instance.start()
        except core.AlreadyRunning as running:
            _log.info("Another copy is already serving this library; opening it.")
            core.open_in_browser(running.url)
            app.terminate_(None)
            return
        except core.LauncherError as problem:
            _log.error("Startup failed: %s", problem)
            self.exit_code = 1

            def choose(index):
                if index == 1:
                    _reveal(self.instance.paths.log_file)
                self._quit()

            self.present("Little Archive could not start", str(problem), ["Quit", "Show Log"], then=choose)
            return
        self.started = True
        # Keep timers and the server responsive while the app has no window in front.
        self.activity = NSProcessInfo.processInfo().beginActivityWithOptions_reason_(
            NSActivityUserInitiatedAllowingIdleSystemSleep, "Serving your private Little Archive library")
        if self.instance.needs_welcome():
            self._welcome()
        else:
            core.open_in_browser(self.instance.url)

    def tick_(self, timer):
        try:
            if self.stop_requested:
                self._shutdown()
                self.ticks_since_terminate += 1
                if self.ticks_since_terminate == 1:
                    NSApplication.sharedApplication().terminate_(None)
                elif self.ticks_since_terminate > 6:
                    # The library is already stopped cleanly; do not hang on a stuck terminate.
                    os._exit(self.exit_code)
            elif self.started and not self.shut_down and not self.reported_failure and not self.instance.running:
                _log.error("The server stopped unexpectedly.")
                self.reported_failure = True
                self.exit_code = 1
                self.present("Little Archive stopped", "The library server stopped unexpectedly. Open Little Archive again. Details are in the log.", ["Quit"], then=self._quit)
        except Exception:
            _log.exception("Unexpected failure in the status check.")

    def applicationShouldTerminate_(self, sender):
        self._shutdown()
        return _TERMINATE_NOW

    def applicationWillTerminate_(self, notification):
        self._shutdown()

    @objc.python_method
    def _shutdown(self):
        if self.shut_down:
            return
        self.shut_down = True
        try:
            self.instance.stop()
            _log.info("Server stopped; quitting.")
        except Exception:
            _log.exception("Error while stopping the server.")
        if self.activity is not None:
            NSProcessInfo.processInfo().endActivity_(self.activity)
            self.activity = None

    def applicationShouldHandleReopen_hasVisibleWindows_(self, app, has_windows):
        # Clicking the Dock icon of the running app opens the library again.
        if self.instance.running and not self.open_windows:
            core.open_in_browser(self.instance.url)
        return False

    def applicationDockMenu_(self, app):
        menu = NSMenu.alloc().init()
        item = menu.addItemWithTitle_action_keyEquivalent_("Open Little Archive", "openLibrary:", "")
        item.setTarget_(self)
        return menu

    # --- Menu actions --------------------------------------------------------------

    def openLibrary_(self, sender):
        if self.instance.running:
            core.open_in_browser(self.instance.url)

    def showFolder_(self, sender):
        _reveal(self.instance.paths.root)

    def showPassword_(self, sender):
        password = self.instance.owner_password()
        if not password:
            self.present("No saved password", "Little Archive has no saved sign-in password for this library, so there is nothing to show. "
                         "If you changed it yourself, use the password you chose.", ["OK"])
            return
        message = "This is the password for your library. Anyone who can see it can sign in, so keep it somewhere private."
        self.present("Your sign-in password", message, ["Copy Password", "Done"], _password_field(password),
                     then=lambda index: _copy_concealed(password) if index == 0 else None)

    @objc.python_method
    def _welcome(self):
        password = self.instance.owner_password()
        if not password:
            core.open_in_browser(self.instance.url)
            return

        def finish(index):
            if index == 0:
                _copy_concealed(password)
            self.instance.acknowledge_welcome()
            core.open_in_browser(self.instance.url)

        message = (f"Your library is stored privately on this Mac, in:\n{_friendly_path(self.instance.paths.root)}\n\n"
                   "Little Archive opens in your web browser. Sign in with the password below, and save it in your "
                   "password manager. You can show it again from the Little Archive menu.")
        self.present("Welcome to Little Archive", message, ["Copy Password and Open", "Open"], _password_field(password), then=finish)

    @objc.python_method
    def request_stop(self):
        self.stop_requested = True


def _install_menu(app, delegate):
    main_menu = NSMenu.alloc().init()
    app_item = NSMenuItem.alloc().init()
    main_menu.addItem_(app_item)
    menu = NSMenu.alloc().init()
    menu.addItemWithTitle_action_keyEquivalent_("About Little Archive", "orderFrontStandardAboutPanel:", "")
    menu.addItem_(NSMenuItem.separatorItem())
    for title, action, key in (("Open Little Archive in Browser", "openLibrary:", "o"),
                               ("Show Sign-in Password…", "showPassword:", ""),
                               ("Show Library Folder in Finder", "showFolder:", "")):
        item = menu.addItemWithTitle_action_keyEquivalent_(title, action, key)
        item.setTarget_(delegate)
    menu.addItem_(NSMenuItem.separatorItem())
    menu.addItemWithTitle_action_keyEquivalent_("Hide Little Archive", "hide:", "h")
    menu.addItemWithTitle_action_keyEquivalent_("Quit Little Archive", "terminate:", "q")
    app_item.setSubmenu_(menu)
    # Cut/Copy/Paste/Select All, so the password can be selected and copied with the keyboard.
    edit_item = NSMenuItem.alloc().init()
    main_menu.addItem_(edit_item)
    edit = NSMenu.alloc().initWithTitle_("Edit")
    for title, action, key in (("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")):
        edit.addItemWithTitle_action_keyEquivalent_(title, action, key)
    edit_item.setSubmenu_(edit)
    app.setMainMenu_(main_menu)


def run(instance):
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
    delegate = _Delegate.alloc().initWithInstance_(instance)
    app.setDelegate_(delegate)
    _install_menu(app, delegate)
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, lambda *_: delegate.request_stop())
    app.run()
    return delegate.exit_code
