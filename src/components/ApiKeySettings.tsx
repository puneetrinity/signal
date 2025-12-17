'use client';

import { useState } from 'react';
import { useApiKey } from '@/contexts/ApiKeyContext';
import { Button } from '@/components/ui/button';
import { Settings, Check, X, Key, Eye, EyeOff } from 'lucide-react';

interface ApiKeySettingsProps {
  variant?: 'button' | 'inline';
}

export function ApiKeySettings({ variant = 'button' }: ApiKeySettingsProps) {
  const { apiKey, setApiKey, isConfigured, clearApiKey } = useApiKey();
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showKey, setShowKey] = useState(false);

  const handleSave = () => {
    if (inputValue.trim()) {
      setApiKey(inputValue.trim());
      setInputValue('');
      setIsOpen(false);
    }
  };

  const handleClear = () => {
    clearApiKey();
    setInputValue('');
  };

  if (variant === 'inline') {
    return (
      <div className="flex items-center gap-2">
        {isConfigured ? (
          <>
            <span className="text-xs text-green-500 flex items-center gap-1">
              <Check className="h-3 w-3" />
              API Key configured
            </span>
            <Button size="sm" variant="ghost" onClick={handleClear} className="h-6 px-2 text-xs">
              Clear
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setIsOpen(true)} className="h-6 px-2 text-xs">
            <Key className="h-3 w-3 mr-1" />
            Set API Key
          </Button>
        )}

        {isOpen && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setIsOpen(false)}>
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-white mb-4">Configure API Key</h3>
              <p className="text-sm text-zinc-400 mb-4">
                Enter your API key to enable enrichment features. The key is stored locally in your browser.
              </p>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="Enter API key..."
                  className="w-full bg-[#0D0D1A] border border-purple-500/20 rounded-lg px-4 py-2 pr-10 text-white placeholder:text-zinc-500 focus:outline-none focus:border-purple-500/50"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <Button variant="ghost" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={!inputValue.trim()}>Save</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setIsOpen(true)}
        className={isConfigured ? 'text-green-500' : 'text-zinc-400'}
      >
        {isConfigured ? (
          <Check className="h-4 w-4" />
        ) : (
          <Settings className="h-4 w-4" />
        )}
      </Button>

      {isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setIsOpen(false)}>
          <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">API Key Settings</h3>
              <button onClick={() => setIsOpen(false)} className="text-zinc-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-zinc-400 mb-4">
              Enter your API key to enable enrichment features like identity discovery and email extraction.
              The key is stored locally in your browser.
            </p>

            {isConfigured ? (
              <div className="space-y-4">
                <div className="bg-[#0D0D1A] border border-green-500/20 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-green-500">
                    <Check className="h-4 w-4" />
                    <span className="text-sm font-medium">API Key configured</span>
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    Key: {apiKey?.slice(0, 8)}...{apiKey?.slice(-4)}
                  </p>
                </div>
                <div className="flex justify-between">
                  <Button variant="destructive" size="sm" onClick={handleClear}>
                    Remove Key
                  </Button>
                  <Button variant="outline" onClick={() => setIsOpen(false)}>
                    Close
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder="Enter API key..."
                    className="w-full bg-[#0D0D1A] border border-purple-500/20 rounded-lg px-4 py-3 pr-10 text-white placeholder:text-zinc-500 focus:outline-none focus:border-purple-500/50"
                    onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setIsOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSave} disabled={!inputValue.trim()}>
                    Save Key
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
