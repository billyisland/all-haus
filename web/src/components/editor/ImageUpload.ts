import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { uploadImage } from '../../lib/media'

// =============================================================================
// ImageUpload TipTap Extension
//
// Handles drag-and-drop and paste image uploads. When a file is dropped
// or pasted, it uploads to Blossom via the gateway and inserts the returned
// URL as a TipTap Image node.
// =============================================================================

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export interface ImageUploadOptions {
  onUploadStart?: () => void
  onUploadEnd?: () => void
  onUploadError?: (error: Error) => void
}

export const ImageUpload = Extension.create<ImageUploadOptions>({
  name: 'imageUpload',

  addOptions() {
    return {
      onUploadStart: undefined,
      onUploadEnd: undefined,
      onUploadError: undefined,
    }
  },

  addProseMirrorPlugins() {
    const options = this.options

    return [
      new Plugin({
        key: new PluginKey('imageUpload'),
        props: {
          handleDrop(view, event) {
            const files = event.dataTransfer?.files
            if (!files || files.length === 0) return false

            const imageFiles = Array.from(files).filter(f =>
              ALLOWED_TYPES.includes(f.type)
            )
            if (imageFiles.length === 0) return false

            event.preventDefault()

            for (const file of imageFiles) {
              void handleFileUpload(file, view, options)
            }

            return true
          },

          handlePaste(view, event) {
            const files = event.clipboardData?.files
            if (!files || files.length === 0) return false

            const imageFiles = Array.from(files).filter(f =>
              ALLOWED_TYPES.includes(f.type)
            )
            if (imageFiles.length === 0) return false

            event.preventDefault()

            for (const file of imageFiles) {
              void handleFileUpload(file, view, options)
            }

            return true
          },
        },
      }),
    ]
  },
})

async function handleFileUpload(
  file: File,
  view: any,
  options: ImageUploadOptions
) {
  options.onUploadStart?.()

  try {
    const result = await uploadImage(file)

    // Insert image at the current position
    const { state } = view
    const { tr, schema } = state
    const imageNode = schema.nodes.image?.create({ src: result.url })
    if (imageNode) {
      const transaction = tr.replaceSelectionWith(imageNode)
      view.dispatch(transaction)
    }
  } catch (err) {
    options.onUploadError?.(err instanceof Error ? err : new Error('Upload failed'))
  } finally {
    options.onUploadEnd?.()
  }
}
