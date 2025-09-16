import { useCallback, useRef, useEffect } from 'react';
import { AgentEvent, ThinkingProgress, Message } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RAW_WS_BASE: string | undefined = (import.meta as any).env.VITE_WS_BASE_URL;
const WS_BASE: string = (RAW_WS_BASE && RAW_WS_BASE !== 'undefined')
  ? RAW_WS_BASE
  : 'ws://localhost:8000/ws';

interface UseWebSocketProps {
  userId: string;
  setCurrentThinking: (updater: (prev: ThinkingProgress | null) => ThinkingProgress | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setLoading: (loading: boolean) => void;
  setCurrentTaskId: (taskId: string | null) => void;
  setCancelling: (cancelling: boolean) => void;
  setSteering: (steering: boolean) => void;
  setSteerMode: (steerMode: boolean) => void;
  setSteeringStatus: (status: 'idle' | 'sending' | 'applied' | 'failed' | null) => void;
  setSubAgentProgress?: React.Dispatch<React.SetStateAction<Record<string, ThinkingProgress>>>;
  setResearchProgress?: React.Dispatch<React.SetStateAction<number | null>>;
}

export const useWebSocket = ({
  userId,
  setCurrentThinking,
  setMessages,
  setLoading,
  setCurrentTaskId,
  setCancelling,
  setSteering,
  setSteerMode,
  setSteeringStatus,
  setSubAgentProgress,
  setResearchProgress,
}: UseWebSocketProps) => {
  const wsRef = useRef<WebSocket | null>(null);
  const thinkingRef = useRef<ThinkingProgress | null>(null);
  const processedTasksRef = useRef<Set<string>>(new Set());
  const subAgentProgressRef = useRef<Record<string, ThinkingProgress>>({});

  const handleWSMessage = useCallback((evt: MessageEvent) => {
    const event: AgentEvent = JSON.parse(evt.data);
    console.log('WS event:', event);

    const updateThinking = (updater: (prev: ThinkingProgress | null) => ThinkingProgress | null) => {
      setCurrentThinking(prev => {
        const next = updater(prev);
        thinkingRef.current = next;
        return next;
      });
    };

    const updateSubAgentThinking = (
      taskId: string,
      updater: (prev: ThinkingProgress | null) => ThinkingProgress | null,
    ) => {
      setSubAgentProgress?.(prev => {
        const current = prev[taskId] ?? null;
        const next    = updater(current);
        if (!next) return prev; // do nothing if null
        const updated = { ...prev, [taskId]: next };
        subAgentProgressRef.current = updated;
        return updated;
      });
    };

    if (subAgentProgressRef.current[event.task_id]) {
      switch (event.event_type) {

        case "batch_progress": {
          const batchId = event.data?.batch_id;
          const newProgress = event.data?.progress;
        }

        case "batch_completed": {
          const batchId = event.data?.batch_id;
        }
        
        case 'progress_update_tool_action_started': {
          const toolCall = event.data?.args?.[0];
          if (!toolCall) break;

          updateSubAgentThinking(event.task_id, prev => {
            const base: ThinkingProgress = prev ?? {
              task_id    : event.task_id,
              tool_calls : {},
              is_complete: false,
            };
            return {
              ...base,
              tool_calls: {
                ...base.tool_calls,
                [toolCall.id]: {
                  id       : toolCall.id,
                  tool_name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                  status   : 'started',
                },
              },
            };
          });
          break;
        }

        case 'progress_update_tool_action_completed': {
          const resp     = event.data?.result;
          const toolCall = resp?.tool_call;
          if (!toolCall) break;

          updateSubAgentThinking(event.task_id, prev => {
            if (!prev) return null;
            return {
              ...prev,
              tool_calls: {
                ...prev.tool_calls,
                [toolCall.id]: {
                  ...prev.tool_calls[toolCall.id],
                  status: 'completed',
                  result: resp.output_data,
                },
              },
            };
          });
          break;
        }

        case 'progress_update_tool_action_failed': {
          const toolCall = event.data?.args?.[0];
          if (!toolCall) break;

          updateSubAgentThinking(event.task_id, prev => {
            if (!prev) return null;
            return {
              ...prev,
              tool_calls: {
                ...prev.tool_calls,
                [toolCall.id]: {
                  ...prev.tool_calls[toolCall.id],
                  status: 'failed',
                  error : event.error,
                },
              },
            };
          });
          break;
        }

        case 'progress_update_completion_failed':
          updateSubAgentThinking(event.task_id, prev => (prev ? { ...prev, error: event.error } : null));
          break;

        case 'agent_output': {
          const finalData = event.data;

          updateSubAgentThinking(event.task_id, prev => {
            if (!prev) return null;
            return {
              ...prev,
              is_complete : true,
              final_output: finalData,
            };
          });

          processedTasksRef.current.add(event.task_id);
          break;
        }

        case 'run_cancelled': {
          updateSubAgentThinking(event.task_id, prev => (
            prev ? { ...prev, is_complete: true, error: 'Task cancelled by user' } : null
          ));
          processedTasksRef.current.add(event.task_id);
          break;
        }

        case 'run_failed': {
          updateSubAgentThinking(event.task_id, prev => (
            prev ? { ...prev, is_complete: true, error: event.error || 'Agent failed to complete the task' } : null
          ));
          processedTasksRef.current.add(event.task_id);
          break;
        }

        default:
          console.log('Unhandled sub-agent event:', event);
      }

      return; // We've handled the event as sub-agent, stop processing further for main agent path
    }

    // Handle batch-level events (e.g., progress updates for research batches)
    switch (event.event_type) {
      case 'batch_progress': {
        const pct =
          typeof (event as any).progress === 'number'
            ? (event as any).progress
            : event.data?.progress;
        if (pct !== undefined && setResearchProgress) {
          setResearchProgress(pct);
        }
        return; // handled
      }
      case 'batch_completed':
        if (setResearchProgress) setResearchProgress(100);
        return;
      default:
        // continue below
        break;
    }

    switch (event.event_type) {
      case 'progress_update_tool_action_started': {
        const toolCall = event.data?.args?.[0];
        if (!toolCall) break;

        updateThinking(prev => {
          const base: ThinkingProgress = prev ?? {
            task_id    : event.task_id,
            tool_calls : {},
            is_complete: false,
          };
          return {
            ...base,
            tool_calls: {
              ...base.tool_calls,
              [toolCall.id]: {
                id       : toolCall.id,
                tool_name: toolCall.function.name,
                arguments: toolCall.function.arguments,
                status   : 'started',
              },
            },
          };
        });
        break;
      }

      case 'progress_update_tool_action_completed': {
        const resp      = event.data?.result;
        const toolCall  = resp?.tool_call;
        if (!toolCall) break;

        updateThinking(prev => {
          if (!prev) return null;
          return {
            ...prev,
            tool_calls: {
              ...prev.tool_calls,
              [toolCall.id]: {
                ...prev.tool_calls[toolCall.id],
                status: 'completed',
                result: resp.output_data,
              },
            },
          };
        });

        if (resp?.tool_call?.function?.name === 'research' && Array.isArray(resp.output_data)) {
          // Reset batch progress when a new research batch starts
          setResearchProgress?.(0);
          const taskIds: string[] = resp.output_data;
          setSubAgentProgress?.(prev => {
            const updated = { ...prev };
            taskIds.forEach(id => {
              if (!updated[id]) {
                updated[id] = {
                  task_id    : id,
                  tool_calls : {},
                  is_complete: false,
                };
              }
            });
            subAgentProgressRef.current = updated;
            return updated;
          });
        }
        break;
      }

      case 'progress_update_tool_action_failed': {
        const toolCall = event.data?.args?.[0];
        if (!toolCall) break;

        updateThinking(prev => {
          if (!prev) return null;
          return {
            ...prev,
            tool_calls: {
              ...prev.tool_calls,
              [toolCall.id]: {
                ...prev.tool_calls[toolCall.id],
                status: 'failed',
                error : event.error,
              },
            },
          };
        });
        break;
      }

      case 'progress_update_completion_failed':
        updateThinking(prev => (prev ? { ...prev, error: event.error } : null));
        break;

      case 'run_steering_applied':
        setSteeringStatus('applied');
        setSteering(false);
        setTimeout(() => setSteeringStatus(null), 2000);
        break;

      case 'run_steering_failed':
        setSteeringStatus('failed');
        setSteering(false);
        setSteerMode(false);
        setTimeout(() => setSteeringStatus(null), 3000);
        break;

      case 'agent_output': {
        if (processedTasksRef.current.has(event.task_id)) break;

        const content =
          typeof event.data === 'string'
            ? event.data
            : event.data?.final_output ?? JSON.stringify(event.data, null, 2);

        setMessages(prev => [
          ...prev,
          {
            id: Date.now(),
            role: 'assistant',
            content,
            timestamp: new Date(),
          },
        ]);

        const finished = thinkingRef.current
          ? { ...thinkingRef.current, is_complete: true, final_output: event.data }
          : null;

        if (finished) {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            return [
              ...prev.slice(0, -1),
              { ...last, thinking: finished },
            ];
          });
        }

        setCurrentThinking(() => null);
        setLoading(false);
        setCurrentTaskId(null);
        setSteering(false);
        setSteerMode(false);
        setSteeringStatus(null);

        // Clear research progress when main agent run completes
        setResearchProgress?.(null);
        processedTasksRef.current.add(event.task_id);
        break;
      }

      case 'run_cancelled': {
        if (processedTasksRef.current.has(event.task_id)) break;

        const snap = thinkingRef.current;
        let message = 'Task was cancelled.';
        let snapshotThinking: ThinkingProgress | undefined;

        if (snap && Object.keys(snap.tool_calls).length) {
          message = "Task was cancelled."

          snapshotThinking = {
            ...snap,
            is_complete: true,
            error: 'Task cancelled by user',
          };
        }

        setMessages(prev => [
          ...prev,
          {
            id: Date.now(),
            role: 'assistant',
            content: message,
            timestamp: new Date(),
            thinking: snapshotThinking,
          },
        ]);

        setCurrentThinking(() => null);
        setLoading(false);
        setCancelling(false);
        setCurrentTaskId(null);
        setSteering(false);
        setSteerMode(false);
        setSteeringStatus(null);
        setResearchProgress?.(null);
        processedTasksRef.current.add(event.task_id);
        break;
      }

      case 'run_failed': {
        if (processedTasksRef.current.has(event.task_id)) break;

        const snap = thinkingRef.current;
        let message = 'Failed to get agent response.';
        let snapshotThinking: ThinkingProgress | undefined;

        if (snap && Object.keys(snap.tool_calls).length) {
          message = "Failed to get agent response."

          snapshotThinking = {
            ...snap,
            is_complete: true,
            error: event.error || 'Agent failed to complete the task',
          };
        }

        setMessages(prev => [
          ...prev,
          {
            id: Date.now(),
            role: 'assistant',
            content: message,
            timestamp: new Date(),
            thinking: snapshotThinking,
          },
        ]);

        setCurrentThinking(() => null);
        setLoading(false);
        setCancelling(false);
        setCurrentTaskId(null);
        setSteering(false);
        setSteerMode(false);
        setSteeringStatus(null);
        setResearchProgress?.(null);
        processedTasksRef.current.add(event.task_id);
        break;
      }

      default:
        console.log('Unhandled event:', event);
    }
  }, [setCurrentThinking, setMessages, setLoading, setCurrentTaskId, setCancelling, setSteering, setSteerMode, setSteeringStatus, setSubAgentProgress, setResearchProgress]);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/${userId}`);
    ws.onmessage = handleWSMessage;
    wsRef.current = ws;
    return () => ws.close();
  }, [userId, handleWSMessage]);

  // Keep thinkingRef in sync
  useEffect(() => {
    return setCurrentThinking(prev => {
      thinkingRef.current = prev;
      return prev;
    });
  }, [setCurrentThinking]);

  // Keep subAgentProgressRef in sync
  useEffect(() => {
    return setSubAgentProgress?.(prev => {
      subAgentProgressRef.current = prev;
      return prev;
    });
  }, [setSubAgentProgress]);

  return wsRef;
}; 