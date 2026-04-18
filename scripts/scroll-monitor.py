#!/usr/bin/env python3
"""Monitor X11 scroll events on a specific window and print direction (4=up, 5=down)."""
import sys
from Xlib import display, X

disp = display.Display()
root = disp.screen().root

# Select button press events for scroll buttons (4 and 5)
root.change_attributes(event_mask=X.ButtonPressMask)

while True:
    event = disp.next_event()
    if event.type == X.ButtonPress and event.detail in (4, 5):
        print(event.detail, flush=True)
