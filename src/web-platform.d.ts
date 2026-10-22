// Browser APIs used by the web version that TypeScript's DOM types don't include yet
// (File System Access, launch queue for "Open with", PWA install prompt).

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface Window {
  showOpenFilePicker?(options?: { types?: FilePickerAcceptType[]; multiple?: boolean; id?: string }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: { suggestedName?: string; types?: FilePickerAcceptType[]; id?: string }): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(options?: { id?: string; mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  launchQueue?: { setConsumer(consumer: (params: { files: readonly FileSystemHandle[] }) => void): void };
}

interface FileSystemHandle {
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface ImportMetaEnv {
  readonly VITE_WINDOWS_INSTALLER_URL?: string;
}
