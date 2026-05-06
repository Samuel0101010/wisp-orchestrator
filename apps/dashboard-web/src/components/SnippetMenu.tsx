import { useState } from 'react';
import { PROMPT_SNIPPETS, SNIPPET_CATEGORY_LABELS, type Snippet } from '@/data/promptSnippets';
import { Button } from '@/components/ui/button';

interface Props {
  /** Called when the user picks a snippet. The receiver appends or inserts. */
  onInsert: (snippet: Snippet) => void;
}

/**
 * Dropdown of categorized prompt fragments. Click a snippet → onInsert fires
 * and the menu closes. Owner is responsible for placement (typically appends
 * to the end of the systemPrompt textarea, separated by a newline).
 */
export function SnippetMenu({ onInsert }: Props) {
  const [open, setOpen] = useState(false);

  const grouped = new Map<Snippet['category'], Snippet[]>();
  for (const s of PROMPT_SNIPPETS) {
    const arr = grouped.get(s.category) ?? [];
    arr.push(s);
    grouped.set(s.category, arr);
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        data-testid="snippet-menu-toggle"
      >
        {open ? 'Close snippets' : 'Snippets ▾'}
      </Button>
      {open && (
        <div
          className="absolute right-0 z-10 mt-1 max-h-80 w-80 overflow-y-auto rounded-md border bg-popover p-2 shadow-md"
          data-testid="snippet-menu-panel"
        >
          {[...grouped.entries()].map(([category, snippets]) => (
            <div key={category} className="mb-2">
              <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {SNIPPET_CATEGORY_LABELS[category]}
              </p>
              <div className="flex flex-col">
                {snippets.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      onInsert(s);
                      setOpen(false);
                    }}
                    className="rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                    title={s.body}
                    data-testid={`snippet-${s.id}`}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
