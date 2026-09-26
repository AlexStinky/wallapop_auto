'use client';

import { useState, useEffect } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';
import { QueueStatus as QueueStatusType, getQueue, startQueue, stopQueue } from '@/lib/api';
import { Button } from './Button';
import { Card } from './Card';
import toast from 'react-hot-toast';

export function QueueStatus() {
  const [queue, setQueue] = useState<QueueStatusType | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const fetchQueue = async () => {
    try {
      const data = await getQueue();
      setQueue(data);
    } catch {
      // Backend might not be running; silently fail
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleToggle = async () => {
    if (!queue) return;
    setToggling(true);
    try {
      const data = queue.isRunning ? await stopQueue() : await startQueue();
      setQueue(data);
      toast.success(data.isRunning ? 'Чергу запущено' : 'Чергу зупинено');
    } catch {
      toast.error('Помилка керування чергою');
    } finally {
      setToggling(false);
    }
  };

  if (loading) {
    return (
      <Card className="flex items-center justify-center py-6">
        <Loader2 size={20} className="animate-spin text-gray-400" />
      </Card>
    );
  }

  if (!queue) {
    return (
      <Card className="text-center text-sm text-gray-400 py-4">
        Сервер недоступний
      </Card>
    );
  }

  const stats = [
    { label: 'Очікує', value: queue.pending, color: 'text-gray-700' },
    { label: 'Виконано', value: queue.completed, color: 'text-green-600' },
    { label: 'Помилок', value: queue.failed, color: 'text-red-500' },
  ];

  return (
    <Card className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`h-2.5 w-2.5 rounded-full ${queue.isRunning ? 'animate-pulse bg-[#00C9A7]' : 'bg-gray-300'}`}
          />
          <span className="text-sm font-semibold text-gray-800">
            {queue.isRunning ? 'Черга активна' : 'Черга зупинена'}
          </span>
        </div>
        <Button
          variant={queue.isRunning ? 'danger' : 'primary'}
          size="sm"
          onClick={handleToggle}
          loading={toggling}
        >
          {queue.isRunning ? <Square size={13} /> : <Play size={13} />}
          {queue.isRunning ? 'Зупинити' : 'Запустити'}
        </Button>
      </div>

      {/* Processing */}
      {queue.isRunning && queue.processing && (
        <div className="flex items-center gap-2 rounded-lg bg-[#00C9A7]/10 px-3 py-2 text-xs text-[#00C9A7]">
          <Loader2 size={12} className="animate-spin" />
          Публікується: {queue.processing}
        </div>
      )}

      {/* Stats */}
      <div className="flex divide-x divide-gray-100">
        {stats.map(({ label, value, color }) => (
          <div key={label} className="flex flex-1 flex-col items-center gap-0.5 px-2">
            <span className={`text-lg font-bold ${color}`}>{value}</span>
            <span className="text-[10px] text-gray-400">{label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
