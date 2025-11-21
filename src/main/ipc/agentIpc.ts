import { ipcMain, BrowserWindow, Notification } from 'electron';
import { agentService } from '../services/AgentService';
import { codexService } from '../services/CodexService';
import { worktreeService } from '../services/WorktreeService';
import { getAppSettings } from '../settings';
import { log } from '../lib/logger';
import { existsSync, statSync } from 'fs';
import path from 'path';

/**
 * Check if a path is a git worktree (has .git as a file, not a directory)
 */
function isWorktreePath(checkPath: string): boolean {
  try {
    const gitMeta = path.join(checkPath, '.git');
    return existsSync(gitMeta) && statSync(gitMeta).isFile();
  } catch {
    return false;
  }
}

/**
 * Show a system notification for agent task completion.
 * Only shows if: notifications are enabled, supported, and app is not focused.
 */
function showCompletionNotification(providerName: string) {
  try {
    const settings = getAppSettings();

    // Check if notifications are enabled in settings
    if (!settings.notifications?.enabled) return;

    // Check platform support
    if (!Notification.isSupported()) return;

    // Don't notify if any window is focused (user can already see completion)
    const windows = BrowserWindow.getAllWindows();
    const anyFocused = windows.some((w) => w.isFocused());
    if (anyFocused) return;

    // Show notification
    const notification = new Notification({
      title: `${providerName} Task Complete`,
      body: 'Your agent has finished working',
      silent: !settings.notifications?.sound,
    });
    notification.show();
  } catch (error) {
    // Silently fail - notifications are not critical
    console.error('Failed to show notification:', error);
  }
}

export function registerAgentIpc() {
  // Installation check
  ipcMain.handle('agent:check-installation', async (_e, providerId: 'codex' | 'claude') => {
    try {
      const ok = await agentService.isInstalled(providerId);
      return { success: true, isInstalled: ok };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  // Installation instructions
  ipcMain.handle(
    'agent:get-installation-instructions',
    async (_e, providerId: 'codex' | 'claude') => {
      try {
        const text = agentService.getInstallationInstructions(providerId);
        return { success: true, instructions: text };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  );

  // Start streaming
  ipcMain.handle(
    'agent:send-message-stream',
    async (
      _e,
      args: {
        providerId: 'codex' | 'claude';
        workspaceId: string;
        worktreePath: string;
        message: string;
        conversationId?: string;
        autoApprove?: boolean;
      }
    ) => {
      try {
        // Resolve worktree path if workspaceId matches a worktree ID
        // Worktree IDs start with 'wt-' (from WorktreeService.stableIdFromPath)
        let resolvedPath = args.worktreePath;
        if (args.workspaceId.startsWith('wt-')) {
          let worktree = worktreeService.getWorktree(args.workspaceId);
          // If not found in map, try to find it by checking all worktrees
          if (!worktree) {
            const allWorktrees = worktreeService.getAllWorktrees();
            worktree = allWorktrees.find((wt) => wt.id === args.workspaceId);
          }
          if (worktree) {
            resolvedPath = worktree.path;
            log.debug(`Resolved worktree path for workspace ${args.workspaceId}: ${resolvedPath}`);
          } else {
            // Fallback: check if provided path is actually a worktree
            if (!isWorktreePath(args.worktreePath)) {
              log.warn(
                `Worktree ${args.workspaceId} not found and provided path ${args.worktreePath} doesn't appear to be a worktree. ${args.providerId} may run in wrong directory.`
              );
            }
          }
        } else {
          // For non-worktree workspaces (e.g., multi-agent), verify the path is correct
          if (!isWorktreePath(args.worktreePath)) {
            log.debug(`Provided path ${args.worktreePath} for workspace ${args.workspaceId} is not a worktree (expected for multi-agent workspaces)`);
          }
        }
        
        await agentService.startStream({
          ...args,
          worktreePath: resolvedPath,
        });
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  );

  // Stop streaming
  ipcMain.handle(
    'agent:stop-stream',
    async (_e, args: { providerId: 'codex' | 'claude'; workspaceId: string }) => {
      try {
        const ok = await agentService.stopStream(args.providerId, args.workspaceId);
        return { success: ok };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  );

  // Bridge Codex native events to generic agent events so renderer can listen once
  codexService.on('codex:start', (data: any) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((w) =>
      w.webContents.send('agent:stream-start', { providerId: 'codex', ...data })
    );
  });
  codexService.on('codex:output', (data: any) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((w) =>
      w.webContents.send('agent:stream-output', { providerId: 'codex', ...data })
    );
  });
  codexService.on('codex:error', (data: any) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((w) =>
      w.webContents.send('agent:stream-error', { providerId: 'codex', ...data })
    );
  });
  codexService.on('codex:complete', (data: any) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((w) =>
      w.webContents.send('agent:stream-complete', { providerId: 'codex', ...data })
    );
    showCompletionNotification('Codex');
  });

  // Forward AgentService events (Claude et al.)
  agentService.on('agent:output', (data: any) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((w) => w.webContents.send('agent:stream-output', data));
  });
  agentService.on('agent:start', (data: any) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((w) => w.webContents.send('agent:stream-start', data));
  });
  agentService.on('agent:error', (data: any) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((w) => w.webContents.send('agent:stream-error', data));
  });
  agentService.on('agent:complete', (data: any) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((w) => w.webContents.send('agent:stream-complete', data));
    const providerName = data.providerId === 'claude' ? 'Claude' : 'Agent';
    showCompletionNotification(providerName);
  });
}
