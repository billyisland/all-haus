// `inert` for React 18. The runtime does not know the attribute: `inert={true}`
// warns and renders nothing, and only a string reaches the DOM. The types
// (`react/experimental`, loaded here) ask for a boolean, which is React 19's
// spelling. So the one working form lives here, cast once, with `aria-hidden`
// beside it — a subtree taken out of the interaction is taken out of the
// accessibility tree too. Spread it: `{...(hidden ? INERT : undefined)}`.
export const INERT = { inert: "", "aria-hidden": true } as unknown as {
  inert: boolean;
  "aria-hidden": true;
};
