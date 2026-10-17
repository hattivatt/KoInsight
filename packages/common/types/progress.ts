import { User } from './user.js';

export type Progress = {
  id: number;
  user_id: number;
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
  created_at: Date;
  updated_at: Date;
};

export type ProgressWithUsername = Progress & Pick<User, 'username'>;
