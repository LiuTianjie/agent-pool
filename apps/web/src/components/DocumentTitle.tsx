import { useEffect } from 'react';

export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = title === 'Agent Pool' ? title : `${title} · Agent Pool`;
    return () => {
      document.title = previous;
    };
  }, [title]);
  return null;
}
