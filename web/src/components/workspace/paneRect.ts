// A Glasshouse pane's on-screen box, in viewport px. Its own module so a store
// can name the type without importing the component (and so the handoff that
// passes one between two panes has a single spelling of it).
export interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
