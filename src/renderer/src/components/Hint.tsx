// The "i" next to a settings label.
//
// A row's static explanation used to sit under its label, which made every row two lines
// tall and Companion a three-screen scroll. It lives behind this mark now, shown on hover
// and on keyboard focus (styles in SettingsView.css). Only explanation goes here: a line
// that reports state (a registered shortcut, a path, an error) stays visible in the row.

export default function Hint({ text }: { text: string }) {
  if (!text) return null
  return (
    <span className="srow-info" tabIndex={0} role="note" aria-label={text} data-tip={text}>
      i
    </span>
  )
}
