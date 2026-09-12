/**
 * DOM methods jsdom does not implement.
 *
 * Loaded as a vitest setup file so a component is not forced to defend itself
 * against a test environment. `scrollIntoView` exists in every browser the
 * product runs in, and guarding it inside a component would only document
 * jsdom's gaps in the product's source.
 *
 * Each shim records what it was asked to do, so a test can assert the call
 * happened rather than merely that it did not throw.
 */

export interface ScrollIntoViewCall {
  readonly element: Element
  readonly options: ScrollIntoViewOptions | boolean | undefined
}

export const scrollIntoViewCalls: ScrollIntoViewCall[] = []

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(
    this: Element,
    options?: ScrollIntoViewOptions | boolean,
  ) {
    scrollIntoViewCalls.push({ element: this, options })
  }
}
