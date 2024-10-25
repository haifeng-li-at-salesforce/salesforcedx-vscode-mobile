/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */

import path from 'path';
import { ObjectInfo, ObjectInfoRepresentation } from '../types';
import { Connection } from '@salesforce/core';

import * as fs from 'fs';

/**
 *
 */
export class ObjectInfoCache {
    objectInfoInMemoCache = new Map<string, ObjectInfo>();

    // Ongoing object fetching promise
    objectInfoPromises = new Map<string, Promise<ObjectInfo | undefined>>();

    // The entity types the user has access to
    entities: string[] = [];

    objectInfoFolder: string;
    entityListFile: string; 
    // The connection to make network call to fetch object info.
    connection: Connection;

    /**
     * @param cacheFolder The root folder to hold object info. 
     * It is something like '<projectRoot>/.sf/orgName/'
     * 
     * @param connection the connection to the org, used to make network call. 
     */
    constructor(rootFolder: string, connection: Connection) {
    
        this.connection = connection;

        this.objectInfoFolder = path.join(rootFolder, 'objectInfos'); 
        this.entityListFile = path.join(this.objectInfoFolder, 'entity_list.json')
        if (!fs.existsSync(this.objectInfoFolder)) {
            fs.mkdirSync(this.objectInfoFolder, { recursive: true });
        }

        this.fetchEntityList();
    }

    // Acquires ObjectInfo data by first searching in memory, then on disk, and finally over the network.
    public async getObjectInfo(
        objectApiName: string
    ): Promise<ObjectInfo | undefined> {

        if (!this.isConnectionValid()) {
            return undefined;
        }

        const objectInfo = this.getObjectInfoFromCache(objectApiName);
        if (objectInfo !== undefined) {
            return objectInfo;
        }

        // Network loading is going on
        let objectInfoNetworkResponsePromise =
            this.objectInfoPromises.get(objectApiName);
        if (objectInfoNetworkResponsePromise === undefined) {
            objectInfoNetworkResponsePromise = new Promise<
                ObjectInfo | undefined
            >(async (resolve) => {

                // Skip fetch if connect is invalid or entity is not visible to the user.
                if (!this.isConnectionValid() || 
                    this.entities.indexOf(objectApiName) === -1) 
                {
                    return undefined
                }

                try {

                    const objectInfo = (await this.connection.request(
                        `${this.connection.baseUrl()}/ui-api/object-info/${objectApiName}`
                    )) as ObjectInfoRepresentation;

                    if (objectInfo === undefined) {
                        return undefined;
                    }

                    this.objectInfoResponseCallback(
                        objectApiName,
                        objectInfo
                    );
                    return resolve(new ObjectInfo(objectInfo));

                } catch (e) {
                    console.log(`Failed to fetch object info for ${objectApiName}. ${e}`);
                    return undefined;
                }

            }).finally(() => {
                this.objectInfoPromises.delete(objectApiName);
            });

            this.objectInfoPromises.set(
                objectApiName,
                objectInfoNetworkResponsePromise
            );
        }
        return objectInfoNetworkResponsePromise;
    }

    // Remove in memory, file system cache object info and entity list. 
    cleanup() {
        this.entities.splice(0, this.entities.length);
        this.objectInfoInMemoCache.clear();
        this.objectInfoPromises.clear();

        fs.rmSync(this.objectInfoFolder, {
            force: true,
            recursive: true,
            maxRetries: 3
        });
    }

    isConnectionValid(): boolean {
        return this.connection.getUsername() !== undefined;
    }


    /**
     * Fetch the entity list fom server and populate into L1 and L2
     * @param connection 
     */
    private async fetchEntityList() {

        if (!fs.existsSync(this.entityListFile)) {
            // No L2 cache, fetch from server and cache it
            const globalResult = await this.connection.describeGlobal();
            const entityList = globalResult.sobjects.map(
                (sObjectResult) => sObjectResult.name
            );
            this.entities = entityList;
            fs.writeFileSync(this.entityListFile, JSON.stringify(entityList), {
                mode: 0o666
            });

        } else {
            // In L2 cache, load into L1
            const entityContent = fs.readFileSync(this.entityListFile, 'utf8');
            this.entities = JSON.parse(entityContent);
        }
    }

    private fetchObjectInfoFromDisk(
        objectApiName: string
    ): ObjectInfo | undefined {
        const objectInfoJsonFile = path.join(
            this.objectInfoFolder,
            `${objectApiName}.json`
        );
        if (!fs.existsSync(objectInfoJsonFile)) {
            return undefined;
        }

        const objectInfoStr = fs.readFileSync(objectInfoJsonFile, 'utf-8');
        return new ObjectInfo(JSON.parse(objectInfoStr) as ObjectInfoRepresentation);
    }

    private getObjectInfoFromCache(
        objectApiName: string
    ): ObjectInfo | undefined {
        // Checks mem cache
        let objectInfo = this.objectInfoInMemoCache.get(objectApiName);

        if (objectInfo !== undefined) {
            return objectInfo;
        }

        // Checks disk cache
        objectInfo = this.fetchObjectInfoFromDisk(objectApiName);
        if (objectInfo !== undefined) {
            this.objectInfoInMemoCache.set(objectApiName, objectInfo);
            return objectInfo;
        }
        return undefined;
    }

    /**
     * Put the object info from network into L1 and L2 cache. 
     * @param objectApiName 
     * @param objectInfo 
     */
    private objectInfoResponseCallback(
        objectApiName: string,
        objectInfo: ObjectInfoRepresentation
    ) {

        // Put in L1
        this.objectInfoInMemoCache.set(objectApiName, new ObjectInfo(objectInfo));

        // stringify and save into L2
        const objectInfoStr = JSON.stringify(objectInfo);
        const objectInfoFile = path.join(
            this.objectInfoFolder,
            `${objectApiName}.json`
        );

        if (fs.existsSync(objectInfoFile)) {
            fs.unlinkSync(objectInfoFile);
        }

        fs.writeFileSync(objectInfoFile, objectInfoStr, { mode: 0o666 });
    }
}
