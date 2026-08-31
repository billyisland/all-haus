import type { ReactNode } from 'react'

type Width = 'article' | 'feed' | 'content'

const WIDTH_CLASS: Record<Width, string> = {
  article: 'max-w-article',
  feed: 'max-w-feed',
  content: 'max-w-content',
}

export function PageHeader({
  title,
  action,
  className = '',
}: {
  title: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 mb-8 ${className}`}>
      <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
        {title}
      </h1>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  )
}

export function PageShell({
  width = 'feed',
  title,
  action,
  children,
}: {
  width?: Width
  title?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={`mx-auto ${WIDTH_CLASS[width]} px-4 sm:px-6 py-12`}>
      {title !== undefined && <PageHeader title={title} action={action} />}
      {children}
    </div>
  )
}
