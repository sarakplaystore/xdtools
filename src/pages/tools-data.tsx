import { ReactNode } from 'react';
import type { Key } from '../app/i18n';
import { IconCompress, IconFont, IconMerge, IconPdfEdit, IconPhoto, IconQr, IconSign, IconSplit, IconVideo } from '../components/icons';

export interface ToolDef {
  key: Key;
  icon: ReactNode;
  /** Route of a working tool; tools still in the works have none. */
  to?: string;
}

export const TOOLS: ToolDef[] = [
  { key: 'tool.pdf', icon: <IconPdfEdit size={40} />, to: '/tools/pdf-editor' },
  { key: 'tool.photo', icon: <IconPhoto size={40} /> },
  { key: 'tool.merge', icon: <IconMerge size={40} /> },
  { key: 'tool.split', icon: <IconSplit size={40} /> },
  { key: 'tool.fontfinder', icon: <IconFont size={40} /> },
  { key: 'tool.compress', icon: <IconCompress size={40} /> },
  { key: 'tool.video', icon: <IconVideo size={40} />, to: '/tools/video' },
  { key: 'tool.sign', icon: <IconSign size={40} /> },
  { key: 'tool.qr', icon: <IconQr size={40} /> },
];
