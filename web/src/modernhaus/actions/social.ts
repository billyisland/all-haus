import { path } from '../gateway'
import type { Registry } from '../door'
import { str } from './shared'

// =============================================================================
// modernhaus — block, unblock, mute, unmute (MODERNHAUS-ADR §D2.4, E6). One
// call each, to the routes the full site's `MuteBlockControls` calls. A block
// is reached only through its confirmation page, which names the person from
// the gateway and never from the address.
// =============================================================================

const settingsPrivacy = () => '/modernhaus/settings/privacy'
const USER = { userId: 'string' } as const

export const SOCIAL_ACTIONS: Registry = {
  block: {
    kind: 'simple',
    method: 'POST',
    fields: USER,
    path: (i) => path`/my/blocks/${str(i.userId)}`,
    done: 'blocked',
    defaultReturn: settingsPrivacy,
  },
  unblock: {
    kind: 'simple',
    method: 'DELETE',
    fields: USER,
    path: (i) => path`/my/blocks/${str(i.userId)}`,
    done: 'unblocked',
    defaultReturn: settingsPrivacy,
  },
  mute: {
    kind: 'simple',
    method: 'POST',
    fields: USER,
    path: (i) => path`/my/mutes/${str(i.userId)}`,
    done: 'muted',
    defaultReturn: settingsPrivacy,
  },
  unmute: {
    kind: 'simple',
    method: 'DELETE',
    fields: USER,
    path: (i) => path`/my/mutes/${str(i.userId)}`,
    done: 'unmuted',
    defaultReturn: settingsPrivacy,
  },
}
