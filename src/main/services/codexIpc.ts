import { ipcMain } from 'electron';
import { log } from '../lib/logger';
import { codexService } from './CodexService';
import { worktreeService } from './WorktreeService';
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

export function setupCodexIpc() {
  // Check if Codex is installed
  ipcMain.handle('codex:check-installation', async () => {
    try {
      const isInstalled = await codexService.getInstallationStatus();
      return { success: true, isInstalled };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Create a new agent for a workspace
  ipcMain.handle('codex:create-agent', async (event, workspaceId: string, worktreePath: string) => {
    try {
      // Resolve worktree path if workspaceId matches a worktree ID
      // Worktree IDs start with 'wt-' (from WorktreeService.stableIdFromPath)
      let resolvedPath = worktreePath;
      if (workspaceId.startsWith('wt-')) {
        let worktree = worktreeService.getWorktree(workspaceId);
        // If not found in map, try to find it by checking all worktrees
        if (!worktree) {
          const allWorktrees = worktreeService.getAllWorktrees();
          worktree = allWorktrees.find((wt) => wt.id === workspaceId);
        }
        if (worktree) {
          resolvedPath = worktree.path;
          log.debug(`Resolved worktree path for workspace ${workspaceId}: ${resolvedPath}`);
        } else {
          // Fallback: check if provided path is actually a worktree
          if (!isWorktreePath(worktreePath)) {
            log.warn(
              `Worktree ${workspaceId} not found and provided path ${worktreePath} doesn't appear to be a worktree. Codex may run in wrong directory.`
            );
          }
        }
      } else {
        // For non-worktree workspaces (e.g., multi-agent), verify the path is correct
        if (!isWorktreePath(worktreePath)) {
          log.debug(`Provided path ${worktreePath} for workspace ${workspaceId} is not a worktree (expected for multi-agent workspaces)`);
        }
      }
      
      const agent = await codexService.createAgent(workspaceId, resolvedPath);
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Send a message to Codex
  ipcMain.handle('codex:send-message', async (event, workspaceId: string, message: string) => {
    try {
      const response = await codexService.sendMessage(workspaceId, message);
      return { success: true, response };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Send a message to Codex with streaming
  ipcMain.handle(
    'codex:send-message-stream',
    async (event, workspaceId: string, message: string, conversationId?: string) => {
      try {
        await codexService.sendMessageStream(workspaceId, message, conversationId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // Get current streaming tail for a workspace (if running)
  ipcMain.handle('codex:get-stream-tail', async (_event, workspaceId: string) => {
    try {
      const info = codexService.getStreamInfo(workspaceId);
      return { success: true, ...info };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('codex:stop-stream', async (event, workspaceId: string) => {
    try {
      log.debug('[codex:stop-stream] request received', workspaceId);
      const stopped = await codexService.stopMessageStream(workspaceId);
      log.debug('[codex:stop-stream] result', { workspaceId, stopped });
      return { success: stopped, stopped };
    } catch (error) {
      log.error('[codex:stop-stream] failed', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Get agent status
  ipcMain.handle('codex:get-agent-status', async (event, workspaceId: string) => {
    try {
      const agent = codexService.getAgentStatus(workspaceId);
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Get all agents
  ipcMain.handle('codex:get-all-agents', async () => {
    try {
      const agents = codexService.getAllAgents();
      return { success: true, agents };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Remove an agent
  ipcMain.handle('codex:remove-agent', async (event, workspaceId: string) => {
    try {
      const removed = codexService.removeAgent(workspaceId);
      return { success: true, removed };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Get installation instructions
  ipcMain.handle('codex:get-installation-instructions', async () => {
    try {
      const instructions = codexService.getInstallationInstructions();
      return { success: true, instructions };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Set up event listeners for streaming
  codexService.on('codex:output', (data) => {
    // Broadcast to all renderer processes
    const windows = require('electron').BrowserWindow.getAllWindows();
    windows.forEach((window: any) => {
      window.webContents.send('codex:stream-output', data);
    });
  });

  codexService.on('codex:error', (data) => {
    // Broadcast to all renderer processes
    const windows = require('electron').BrowserWindow.getAllWindows();
    windows.forEach((window: any) => {
      window.webContents.send('codex:stream-error', data);
    });
  });

  codexService.on('codex:complete', (data) => {
    // Broadcast to all renderer processes
    const windows = require('electron').BrowserWindow.getAllWindows();
    windows.forEach((window: any) => {
      window.webContents.send('codex:stream-complete', data);
    });
  });
}
