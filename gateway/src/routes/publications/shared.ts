/** Default permissions by role */
export const ROLE_DEFAULTS = {
  editor_in_chief: {
    can_publish: true, can_edit_others: true,
    can_manage_members: true, can_manage_finances: true, can_manage_settings: true,
  },
  editor: {
    can_publish: true, can_edit_others: true,
    can_manage_members: false, can_manage_finances: false, can_manage_settings: false,
  },
  contributor: {
    can_publish: false, can_edit_others: false,
    can_manage_members: false, can_manage_finances: false, can_manage_settings: false,
  },
} as const
