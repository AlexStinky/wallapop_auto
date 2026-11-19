'use client';

import { useEffect, useRef } from 'react';

export function usePhotoUrls() {
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const owned = urls.current;
    return () => {
      owned.forEach(url => URL.revokeObjectURL(url));
      owned.clear();
    };
  }, []);

  return {
    create(file: File) {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      return url;
    },
    release(url: string) {
      if (urls.current.delete(url)) URL.revokeObjectURL(url);
    },
  };
}
