// Words shared across the whole app. Only truly generic ones belong here: a label that
// means something specific in one screen gets its own key in that screen's namespace,
// even when the English happens to match.
export default {
  cancel: 'Cancel',
  save: 'Save',
  delete: 'Delete',
  close: 'Close',
  ok: 'OK',
  retry: 'Retry',
  copy: 'Copy',
  rename: 'Rename',
  open: 'Open',
  edit: 'Edit',
  yes: 'Yes',
  no: 'No',
  loading: 'Loading',
  none: 'None',
  unknown: 'Unknown'
} satisfies Record<string, string>
