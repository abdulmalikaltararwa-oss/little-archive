"""Launcher for the Little Archive Mac app.

`core` holds every decision the app makes (where the library lives, which port,
whether another copy is running, how the first-run password is created) without
importing any macOS framework, so it is tested with the rest of the Python suite.
`gui` is the thin AppKit shell around it and is only imported inside the app.
"""
