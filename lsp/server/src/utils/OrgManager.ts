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
    OrgConfigProperties,
    StateAggregator
} from '@salesforce/core';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceUtils } from './workspaceUtils';
import { ObjectInfoCache } from '../objectInfo/ObjectInfoCache';

enum AuthStatus {
    UNKNOWN,
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
const SFDX_DIR = path.join(os.homedir(), '.sfdx')
const SF_DIR = path.join(os.homedir(), '.sf');

export class OrgManager {

    orgName: string = '';
    connection: Connection | undefined;
    authStatus: AuthStatus = AuthStatus.UNKNOWN;
    sfdxDirWatcher: fs.FSWatcher | undefined;
    sfDirWatcher: fs.FSWatcher | undefined;

    objectInfoCache: ObjectInfoCache | undefined;

    authChangeListeners: OrgAuthChangeListener[] = [];

    constructor() {
        this.watchConfig();
        this.onAuthOrgChanged();
    }

    registerOrgAuthChangeListener(listener: OrgAuthChangeListener) {
        this.authChangeListeners.push(listener);
    }

    unregisterOrgAuthChangeListener(listener: OrgAuthChangeListener) {
        this.authChangeListeners = this.authChangeListeners.filter(
            (l) => l !== listener
        );
    }

    cleanup() {
        this.unWatchConfig();
    }

    // Retrieves default organiztion's name.
    private async getDefaultOrgName(): Promise<string> {
        const aggregator = await ConfigAggregator.create();

        await aggregator.reload();

        const currentUserConfig = aggregator.getInfo(
            OrgConfigProperties.TARGET_ORG
        );

        if (currentUserConfig.value) {
            this.orgName = currentUserConfig.value.toString();
            return Promise.resolve(this.orgName);
        }
        return Promise.reject('no org');
    }

    private async getDefaultUserName(): Promise<string | undefined> {
        try {
            const orgName = await this.getDefaultOrgName();
            const aggregator = await StateAggregator.getInstance();
            const username = aggregator.aliases.getUsername(orgName);
            if (username !== null && username !== undefined) {
                return username;
            }
        } catch (error) {
            return undefined;
        }
    }

    // Set up file watches on the ~/.sfdx and ~/.sf to detech org authorization change. 
    private watchConfig() {
        this.sfdxDirWatcher = fs.watch(SFDX_DIR, (eventType, fileName) => {
            this.onAuthOrgChanged();
        });
        this.sfDirWatcher = fs.watch(SF_DIR, (eventType, fileName) => {
            this.onAuthOrgChanged();
        });
    }

    // Remove the file watches on sfdx and sf directories
    private  unWatchConfig() {
        if (this.sfdxDirWatcher !== undefined) {
            this.sfdxDirWatcher.close();
            this.sfdxDirWatcher = undefined;
        }
        if (this.sfDirWatcher !== undefined) {
            this.sfDirWatcher.close();
            this.sfDirWatcher = undefined;
        }
    }

    // Get the latest orgAuth status, if status is changed, call corresponding listeners. 
    private async onAuthOrgChanged() {
        // Get the connection and it's un-authorized status if connection is invalid
        const connection = await this.getConnection();
        const status = connection !== undefined? AuthStatus.AUTHORIZED : AuthStatus.UNAUTHORIZED
        
        if (status !== this.authStatus) {
            if (status === AuthStatus.UNAUTHORIZED) {
                // Authorized -> Unauthorized:  do clean up and call listeners
                this.connection = undefined;
                this.objectInfoCache?.cleanup();
                this.objectInfoCache = undefined;

                this.authChangeListeners.forEach((listener)=>{
                    listener.onLogOut();
                });
            } else {
                // Unauthorized -> Authorized:  create object info cache and call listeners
                this.connection = connection;
                const orgName = await this.getDefaultOrgName();
                
                const cacheRootPath = path.join(
                    WorkspaceUtils.getWorkspaceDir(),
                    SF_DIR,
                    orgName
                );
    
                this.objectInfoCache = new ObjectInfoCache(
                    cacheRootPath,
                    connection!!
                );

                this.authChangeListeners.forEach((listener)=>{
                    listener.onAuthorized();
                });
            }
            this.authStatus = status;
        }
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