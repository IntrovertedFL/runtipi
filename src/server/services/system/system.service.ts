import semver from 'semver';
import { z } from 'zod';
import fetch from 'node-fetch-commonjs';
import { readJsonFile } from '../../common/fs.helpers';
import { EventDispatcher } from '../../core/EventDispatcher';
import { Logger } from '../../core/Logger';
import TipiCache from '../../core/TipiCache';
import { getConfig, setConfig } from '../../core/TipiConfig';

const SYSTEM_STATUS = ['UPDATING', 'RESTARTING', 'RUNNING'] as const;
type SystemStatus = (typeof SYSTEM_STATUS)[keyof typeof SYSTEM_STATUS];

const systemInfoSchema = z.object({
  cpu: z.object({
    load: z.number().default(0),
  }),
  disk: z.object({
    total: z.number().default(0),
    used: z.number().default(0),
    available: z.number().default(0),
  }),
  memory: z.object({
    total: z.number().default(0),
    available: z.number().default(0),
    used: z.number().default(0),
  }),
});

export class SystemServiceClass {
  private cache;

  private dispatcher;

  constructor() {
    this.cache = TipiCache;
    this.dispatcher = EventDispatcher;
  }

  /**
   * Get the current and latest version of Tipi
   * @returns {Promise<{ current: string; latest: string }>}
   */
  public getVersion = async (): Promise<{ current: string; latest?: string }> => {
    try {
      let version = await this.cache.get('latestVersion');

      if (!version) {
        const data = await fetch('https://api.github.com/repos/meienberger/runtipi/releases/latest');
        const release = (await data.json()) as { name: string };

        version = release.name.replace('v', '');
        await this.cache.set('latestVersion', version?.replace('v', '') || '', 60 * 60);
      }

      return { current: getConfig().version, latest: version?.replace('v', '') };
    } catch (e) {
      Logger.error(e);
      return { current: getConfig().version, latest: undefined };
    }
  };

  public static systemInfo = (): z.infer<typeof systemInfoSchema> => {
    const info = systemInfoSchema.safeParse(readJsonFile('/runtipi/state/system-info.json'));

    if (!info.success) {
      throw new Error('Error parsing system info');
    } else {
      return info.data;
    }
  };

  public update = async (): Promise<boolean> => {
    const { current, latest } = await this.getVersion();

    if (getConfig().NODE_ENV === 'development') {
      throw new Error('Cannot update in development mode');
    }

    if (!latest) {
      throw new Error('Could not get latest version');
    }

    if (semver.gt(current, latest)) {
      throw new Error('Current version is newer than latest version');
    }

    if (semver.eq(current, latest)) {
      throw new Error('Current version is already up to date');
    }

    if (semver.major(current) !== semver.major(latest)) {
      throw new Error('The major version has changed. Please update manually (instructions on GitHub)');
    }

    setConfig('status', 'UPDATING');

    this.dispatcher.dispatchEventAsync('update');

    return true;
  };

  public restart = async (): Promise<boolean> => {
    if (getConfig().NODE_ENV === 'development') {
      throw new Error('Cannot restart in development mode');
    }

    setConfig('status', 'RESTARTING');
    this.dispatcher.dispatchEventAsync('restart');

    return true;
  };

  public static status = async (): Promise<{ status: SystemStatus }> => ({
    status: getConfig().status as SystemStatus,
  });
}
