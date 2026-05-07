import React from 'react';
import { cn } from '../../lib/cn.js';

interface SkeletonRowsProps {
  count?: number;
  className?: string;
}

export function SkeletonRows({ count = 3, className }: SkeletonRowsProps) {
  return (
    <div className={className}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-[14px] rounded-[3px] mb-2.5 bg-gradient-to-r from-s2 via-s3 to-s2 bg-[length:200%_100%] animate-[shimmer_1.4s_ease_infinite] rounded"
          style={{ width: `${60 + (i % 3) * 15}%`, opacity: 1 - i * 0.15 }}
        />
      ))}
    </div>
  );
}
