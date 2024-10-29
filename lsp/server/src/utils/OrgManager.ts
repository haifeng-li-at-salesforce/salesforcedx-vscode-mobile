/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */

import {
    AuthInfo,
    ConfigAggregator,
    Connection,
    Org,
    OrgConfigProperties,
    StateAggregator
} from '@salesforce/core';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceUtils } from './workspaceUtils';
import { ObjectInfoCache } from '../objectInfo/ObjectInfoCache';
import { ObjectInfo } from '../types';

type UndefinableString = string | undefined;

enum AuthStatus {
    AUTHORIZED,
    UNAUTHORIZED
}

interface OrgAuthChangeListener {
    onAuthorized(): void;
    onLogOut(): void;
}

/**
 * The full system path to the global sf state folder.
 */
const SFDX_DIR = path.join(os.homedir(), '.sfdx/alias.json');
const SF_DIR = path.join(os.homedir(), '.sf');
const SF_MOBILE_DIR = '.sfmobile';

class OrgState {
    connection: Connection;
    orgName: UndefinableString;
    userName: UndefinableString;
    status: AuthStatus;

    constructor(
        connection: Connection,
        orgName: UndefinableString,
        userName: UndefinableString
    ) {
        this.connection = connection;
        this.orgName = orgName;
        this.userName = userName;
        this.status =
            connection !== undefined
                ? AuthStatus.AUTHORIZED
                : AuthStatus.UNAUTHORIZED;
    }

    isEqual(other?: OrgState): boolean {
        return (
            this.orgName === other?.orgName && this.userName === other?.userName
        );
    }

    getOrgCacheFolder(): string {
        if (this.orgName === undefined) {
            throw Error('Not authorized to org');
        }
        return path.join(
            path.join(WorkspaceUtils.getWorkspaceDir(), SF_MOBILE_DIR),
            this.orgName
        );
    }
}

let instanceCount = 0;

export class OrgManager {
    private static instance: OrgManager;

    orgState: OrgState | undefined;

    // File watcher to detect org authorization or logout
    sfdxDirWatcher: fs.FSWatcher | undefined;
    sfDirWatcher: fs.FSWatcher | undefined;
    sfWorkSpaceWatcher: fs.FSWatcher | undefined;

    objectInfoCache: ObjectInfoCache | undefined;

    authChangeListeners: OrgAuthChangeListener[] = [];

    private constructor() {
        this.watchConfig();
    }

    public static getInstance(): OrgManager {
        if (this.instance === undefined) {
            this.instance = new OrgManager();
        }
        return this.instance;
    }

    registerOrgAuthChangeListener(listener: OrgAuthChangeListener) {
        this.authChangeListeners.push(listener);
    }

    unregisterOrgAuthChangeListener(listener: OrgAuthChangeListener) {
        this.authChangeListeners = this.authChangeListeners.filter(
            (l) => l !== listener
        );
    }

    public async getObjectInfo(
        objectApiName: string
    ): Promise<ObjectInfo | undefined> {
        return this.objectInfoCache?.getObjectInfo(objectApiName);
    }

    cleanup() {
        this.unWatchConfig();
    }

    // Retrieves default organization's name.
    private async getDefaultOrgName(): Promise<string | undefined> {
        const aggregator = await ConfigAggregator.create();

        await aggregator.reload();

        const currentUserConfig = aggregator.getInfo(
            OrgConfigProperties.TARGET_ORG
        );

        if (currentUserConfig.value) {
            const orgName = currentUserConfig.value.toString();
            return Promise.resolve(orgName);
        }
        return undefined;
    }

    private async getDefaultUserName(): Promise<string | undefined> {
        const orgName = await this.getDefaultOrgName();
        if (orgName === undefined) {
            return undefined;
        }
        const aggregator = await StateAggregator.getInstance();
        const username = aggregator.aliases.getUsername(orgName);
        if (username !== null && username !== undefined) {
            return username;
        }

        return undefined;
    }

    /**
     * Set up file watches on the below files to detect
     * 1. ~/.sfdx, ~/.sf: org authorization or logout
     * 2. $workspace$/.sf/config.json: User could authorize to multiple org and switch among them.
     */
    private watchConfig() {
        this.sfdxDirWatcher = fs.watch(SFDX_DIR, (eventType, fileName) => {
            this.debouncedOnAuthOrgChange();
        });
        this.sfDirWatcher = fs.watch(SF_DIR, (eventType, fileName) => {
            this.debouncedOnAuthOrgChange();
        });
        this.sfWorkSpaceWatcher = fs.watch(
            path.join(WorkspaceUtils.getWorkspaceDir(), '.sf/config.json'),
            (eventType, fileName) => {
                this.debouncedOnAuthOrgChange();
            }
        );
    }

    // Remove the file watches on sfdx and sf directories
    private unWatchConfig() {
        if (this.sfdxDirWatcher !== undefined) {
            this.sfdxDirWatcher.close();
            this.sfdxDirWatcher = undefined;
        }
        if (this.sfDirWatcher !== undefined) {
            this.sfDirWatcher.close();
            this.sfDirWatcher = undefined;
        }
        if (this.sfWorkSpaceWatcher !== undefined) {
            this.sfWorkSpaceWatcher.close();
            this.sfWorkSpaceWatcher === undefined;
        }
    }

    debouncedOnAuthOrgChange = debounce(this.onAuthOrgChanged);

    // Get the latest orgAuth status, if status is changed, call corresponding listeners.
    public async onAuthOrgChanged() {
        // Get the connection and it's un-authorized status if connection is invalid
        const orgName = await this.getDefaultOrgName();
        const userName = await this.getDefaultUserName();
        const connection = await this.getConnection();

        const orgState = new OrgState(connection!!, orgName, userName!!);

        if (orgState.isEqual(this.orgState)) {
            return;
        }

        // Authorized -> Unauthorized: do clean up and call listeners
        if (
            this.orgState?.status === AuthStatus.AUTHORIZED &&
            orgState.status === AuthStatus.UNAUTHORIZED
        ) {
            this.doLogoutCleanup(this.orgState);
        }

        // Unauthorized -> Authorized or switch org: create object info cache and call listeners
        if (
            // Unauthorized -> Authorized
            ((this.orgState === undefined ||
                this.orgState.status === AuthStatus.UNAUTHORIZED) &&
                orgState.status === AuthStatus.AUTHORIZED) ||
            // switch org
            (this.orgState !== undefined &&
                this.orgState.status === AuthStatus.AUTHORIZED &&
                orgState !== undefined &&
                orgState.status === AuthStatus.AUTHORIZED &&
                !orgState.isEqual(this.orgState))
        ) {
            this.objectInfoCache = new ObjectInfoCache(
                orgState.getOrgCacheFolder(),
                connection!!
            );

            this.authChangeListeners.forEach((listener) => {
                listener.onAuthorized();
            });
        }
        this.orgState = orgState;
    }

    private doLogoutCleanup(orgState: OrgState) {
        this.objectInfoCache?.cleanup();
        this.objectInfoCache = undefined;

        const cacheFolder = orgState.getOrgCacheFolder();
        fs.rmSync(cacheFolder, {
            force: true,
            recursive: true,
            maxRetries: 3
        });

        this.authChangeListeners.forEach((listener) => {
            listener.onLogOut();
        });
    }

    // Retrieves the Connection which will be used to fetch ObjectInfo remotely.
    private async getConnection(): Promise<Connection | undefined> {
        const username = await this.getDefaultUserName();
        if (username === undefined) {
            return undefined;
        }
        const connect = await Connection.create({
            authInfo: await AuthInfo.create({ username })
        });
        if (connect !== undefined && connect.getUsername() !== undefined) {
            return connect;
        }
        return undefined;
    }
}

const debounce = (fn: Function, ms = 1000) => {
    let count = 0;
    let timeoutId: ReturnType<typeof setTimeout>;
    return function (this: any, ...args: any[]) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), ms);
    };
};
