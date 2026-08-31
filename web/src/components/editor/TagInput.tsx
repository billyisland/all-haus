'use client'

import { useState, useRef, useEffect } from 'react'
import { tags as tagsApi, type TagSuggestion } from '../../lib/api'

interface Props {
  value: string[]
  onChange: (tags: string[]) => void
  max?: number
}

export function TagInput({ value, onChange, max = 5 }: Props) {
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!input.trim()) {
      setSuggestions([])
      setShowDropdown(false)
      return
    }

    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await tagsApi.search(input.trim())
        const filtered = res.tags.filter(t => !value.includes(t.name))
        setSuggestions(filtered)
        setShowDropdown(filtered.length > 0)
      } catch {
        setSuggestions([])
      }
    }, 300)

    return () => clearTimeout(debounceRef.current)
  }, [input, value])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function addTag(name: string) {
    const normalised = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    if (!normalised || value.includes(normalised) || value.length >= max) return
    onChange([...value, normalised])
    setInput('')
    setSuggestions([])
    setShowDropdown(false)
  }

  function removeTag(name: string) {
    onChange(value.filter(t => t !== name))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      if (input.trim()) addTag(input.trim())
    }
    if (e.key === 'Backspace' && !input && value.length > 0) {
      removeTag(value[value.length - 1])
    }
  }

  const atMax = value.length >= max

  return (
    <div ref={containerRef} className="relative">
      <div className="bg-glasshouse-well px-3 py-2 flex flex-wrap items-center gap-2">
        {value.map(tag => (
          <span
            key={tag}
            className="bg-grey-200 px-2 py-0.5 label-ui text-black flex items-center gap-1"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-grey-600 hover:text-black"
            >
              &times;
            </button>
          </span>
        ))}
        {atMax ? (
          <span className="text-ui-xs text-grey-600">5 tags maximum</span>
        ) : (
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add tag..."
            className="flex-1 min-w-[80px] border-none bg-transparent label-ui placeholder:text-grey-300 focus:outline-none"
          />
        )}
      </div>

      {showDropdown && (
        <div className="absolute z-10 top-full left-0 right-0 bg-white shadow-lg mt-1">
          {suggestions.map(s => (
            <button
              key={s.name}
              type="button"
              onClick={() => addTag(s.name)}
              className="w-full flex items-center justify-between px-3 py-2 text-[12px] font-mono uppercase tracking-[0.06em] hover:bg-grey-100 transition-colors"
            >
              <span>{s.name}</span>
              <span className="text-grey-300">({s.count})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
