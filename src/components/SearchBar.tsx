'use client';

import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface SearchBarProps {
  onSearch: (query: string) => void;
  isLoading?: boolean;
  /** Controlled value - when provided, syncs input with external state (e.g., URL) */
  value?: string;
  /** Called on every input change for controlled mode */
  onChange?: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({
  onSearch,
  isLoading = false,
  value,
  onChange,
  placeholder = 'e.g., 10 AI Engineers in SF',
}: SearchBarProps) {
  // Internal state for uncontrolled mode
  const [internalQuery, setInternalQuery] = useState('');

  // Sync internal state when controlled value changes
  useEffect(() => {
    if (value !== undefined) {
      setInternalQuery(value);
    }
  }, [value]);

  const query = value !== undefined ? value : internalQuery;

  const handleChange = (newValue: string) => {
    setInternalQuery(newValue);
    onChange?.(newValue);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-2xl gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          disabled={isLoading}
          className="pl-10"
        />
      </div>
      <Button type="submit" disabled={isLoading || !query.trim()}>
        {isLoading ? 'Searching...' : 'Search'}
      </Button>
    </form>
  );
}
