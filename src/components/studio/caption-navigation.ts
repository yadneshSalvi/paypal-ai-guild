"use client";

/** Editors may prevent navigation until an unsaved measured draft is dealt with. */
export function mayLeaveCaptionReview() {
  return window.dispatchEvent(new Event("guild:caption-review-leave", { cancelable: true }));
}
