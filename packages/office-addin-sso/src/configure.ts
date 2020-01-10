/*
 * Copyright (c) Microsoft. All rights reserved. Licensed under the MIT license. See full license in root of repo. -->
 *
 * This file defines Azure application registration.
 */
import * as chalk from 'chalk';
import * as childProcess from 'child_process';
import * as defaults from './defaults';
import * as fs from 'fs';
import { addSecretToCredentialStore, writeApplicationData } from './ssoDataSettings';
import { ManifestInfo, readManifestFile } from 'office-addin-manifest';
import * as usageDataHelper from './usagedata-helper';
let usageDataInfo: Object = {};
require('dotenv').config();

export async function configureSSOApplication(manifestPath: string, port: string) {
    // Log start time for configuration process
    const ssoConfigStartTime = (new Date()).getTime();

    // Check to see if Azure CLI is installed.  If it isn't installed, then install it
    const cliInstalled = await isAzureCliInstalled();

    if(!cliInstalled) {
        console.log(chalk.yellow("Azure CLI is not installed.  Installing now before proceeding"));
        await installAzureCli();
        if (process.platform === "win32") {
            console.log(chalk.green('Please close your command shell, reopen and run configure-sso again.  This is neccessary to register the path to the Azure CLI'));
        }
        return;
    }

    const userJson: Object = await logIntoAzure();
    if (Object.keys(userJson).length >= 1) {
        console.log('Login was successful!');
        const manifestInfo: ManifestInfo = await readManifestFile(manifestPath);

        // Register application in Azure
        const applicationJson: Object = await createNewApplication(manifestInfo.displayName, port, userJson);

        // Write application data to project files (manifest.xml, .env, src/taskpane/fallbacktaskpane.ts)
        await writeApplicationData(applicationJson['appId'], port, manifestPath);

        // Log out of Azure
        await logoutAzure();

        console.log(chalk.green(`Application with id ${applicationJson['appId']} successfully registered in Azure.  Go to https://ms.portal.azure.com/#home and search for 'App Registrations' to see your application`));

        // Log end time for configuration process and compute in seconds
        const ssoConfigEndTime = (new Date()).getTime();
        const ssoConfigDuration = (ssoConfigEndTime - ssoConfigStartTime) /1000
        
        // Send usage data
        usageDataInfo = {
            Method: ['configureSSOApplication'],
            configDuration: [ssoConfigDuration],
            Platform: [process.platform],
            Succeeded: [true]
        }
        usageDataHelper.sendUsageDataCustomEvent(usageDataInfo);
    }
    else {
        const errorMessage: string = 'Login to Azure did not succeed';
        usageDataHelper.sendUsageDataException('configureSSOApplication', errorMessage);
        throw new Error(errorMessage);
    }
}

async function createNewApplication(ssoAppName: string, port: string, userJson: Object): Promise<Object> {
    try {
        console.log('Registering new application in Azure');
        let azRestCommand = await fs.readFileSync(defaults.azRestAppCreateCommandPath, 'utf8');
        const reName = new RegExp('{SSO-AppName}', 'g');
        const rePort = new RegExp('{PORT}', 'g');
        azRestCommand = azRestCommand.replace(reName, ssoAppName).replace(rePort, port);

        const applicationJson: Object = await promiseExecuteCommand(azRestCommand, true /* returnJson */);

        if (applicationJson) {
            console.log('Application was successfully registered with Azure');
            // Set application IdentifierUri
            await setIdentifierUri(applicationJson, port);

            // Set application sign-in audience
            await setSignInAudience(applicationJson);

            // Grant admin consent for application if logged-in user is a tenant admin
            if (await isUserTenantAdmin(userJson)){
                await grantAdminContent(applicationJson);
                await setTenantReplyUrls(applicationJson);
            }

            // Create an application secret and add to the credential store
            const secret: string = await setApplicationSecret(applicationJson);
            console.log(chalk.green(`App secret is ${secret}`));
            addSecretToCredentialStore(ssoAppName, secret);

            usageDataHelper.sendUsageDataSuccessEvent('createNewApplication');
            return applicationJson;
        } else {
            const errorMessage = 'Failed to register application';
            usageDataHelper.sendUsageDataException('createNewApplication', errorMessage);
            console.log(chalk.red(errorMessage));
            return undefined;
        }
    } catch (err) {
        const errorMessage: string = `Unable to register new application: \n${err}`
        usageDataHelper.sendUsageDataException("createNewApplication", errorMessage);
        throw new Error(errorMessage);
    }
}

async function applicationReady(applicationJson: Object): Promise<boolean> {
    try {
        const azRestCommand: string = `az ad app show --id ${applicationJson['appId']}`
        const appJson: Object = await promiseExecuteCommand(azRestCommand, true /* returnJson */, true /* expectError */);
        return appJson !== "";
    } catch (err) {
        const errorMessage: string = `Unable to get application info: \n${err}`
        usageDataHelper.sendUsageDataException('applicationReady', errorMessage);
        throw new Error(errorMessage);
    }
}

async function grantAdminContent(applicationJson: Object) {
    try {
        console.log('Granting admin consent');
        // Check to see if the application is available before granting admin consent
        let appReady: boolean = false;
        let counter: number = 0;
        while (appReady === false && counter <= 50) {
            appReady = await applicationReady(applicationJson);
            counter++;
        }

        if (counter > 50) {
            const warningMessage: string = 'Application does not appear to be ready to grant admin consent';
            usageDataHelper.sendUsageDataException('grantAdminConsent', warningMessage);
            console.log(chalk.yellow(warningMessage));
            return;
        }

        const azRestCommand: string = `az ad app permission admin-consent --id ${applicationJson['appId']}`;
        await promiseExecuteCommand(azRestCommand);
    } catch (err) {
        const errorMessage: string = `Unable to set grant admin consent: \n${err}`
        usageDataHelper.sendUsageDataException('grantAdminConsent', errorMessage);
        throw new Error(errorMessage);
    }
}

export async function isAzureCliInstalled(): Promise<boolean> {
    try {
        let cliInstalled: boolean = false;
        switch (process.platform) {
            case "win32":
                const appsInstalledWindowsCommand: string = `powershell -ExecutionPolicy Bypass -File "${defaults.getInstalledAppsPath}"`;
                const appsWindows: any = await promiseExecuteCommand(appsInstalledWindowsCommand);
                cliInstalled = appsWindows.filter(app => app.DisplayName === 'Microsoft Azure CLI').length > 0
                // Send usage data
                usageDataInfo = {
                    Method: ['isAzureCliInstalled'],
                    cliInstalled: [cliInstalled],
                    Platform: [process.platform],
                    Succeeded: [true]
                }
                usageDataHelper.sendUsageDataCustomEvent(usageDataInfo);
                return cliInstalled;
            case "darwin":
                const appsInstalledMacCommand = 'brew list';
                const appsMac: Object | string = await promiseExecuteCommand(appsInstalledMacCommand, false /* returnJson */);
                cliInstalled = appsMac.toString().includes('azure-cli');
                // Send usage data
                usageDataInfo = {
                    Method: ['isAzureCliInstalled'],
                    cliInstalled: [cliInstalled],
                    Platform: [process.platform],
                    Succeeded: [true]
                }
                usageDataHelper.sendUsageDataCustomEvent(usageDataInfo);
                return cliInstalled;
            default:
                const errorMessage: string = `Platform not supported: ${process.platform}`;
                usageDataHelper.sendUsageDataException('isAzureCliInstalled', errorMessage);
                throw new Error(errorMessage);
        }        
    } catch (err) {
        const errorMessage: string = `Unable to determine if Azure CLI is installed: \n${err}`;
        usageDataHelper.sendUsageDataException('isAzureCliInstalled', errorMessage);
        throw new Error(errorMessage);
    }
}

async function installAzureCli() {
    try {
        console.log("Downloading and installing Azure CLI - this could take a few minutes");
        switch (process.platform) {
            case "win32":
                const windowsCliInstallCommand = `powershell -ExecutionPolicy Bypass -File "${defaults.azCliInstallCommandPath}"`;
                await promiseExecuteCommand(windowsCliInstallCommand, false /* returnJson */);
                break;
            case "darwin": // macOS
                const macCliInstallCommand = 'brew update && brew install azure-cli';
                await promiseExecuteCommand(macCliInstallCommand, false /* returnJson */);
                break;
            default:
                const errorMessage: string = `Platform not supported: ${process.platform}`;
                usageDataHelper.sendUsageDataException('installAzureCli', errorMessage);
                throw new Error(errorMessage);
        }
        usageDataHelper.sendUsageDataSuccessEvent('installAzureCli');
    } catch (err) {
        const errorMessage: string = `Unable to install Azure CLI: \n${err}`;
        usageDataHelper.sendUsageDataException('installAzureCli', errorMessage);
        throw new Error(errorMessage);
    }
}

async function isUserTenantAdmin(userInfo: Object): Promise<boolean> {
    try {
        console.log("Checking if logged-in user is a tenant admin");
        let azRestCommand: string = fs.readFileSync(defaults.azRestGetTenantRolesPath, 'utf8');
        const tenantRoles: Object = await promiseExecuteCommand(azRestCommand);
        let tenantAdminId: string = '';
        tenantRoles['value'].forEach(item => {
            if (item.displayName === "Company Administrator") {
                tenantAdminId = item.id;
            }
        });

        azRestCommand = fs.readFileSync(defaults.azRestGetTenantAdminMembershipCommandPath, 'utf8');
        azRestCommand = azRestCommand.replace('<TENANT-ADMIN-ID>', tenantAdminId);
        const tenantAdmins: Object = await promiseExecuteCommand(azRestCommand);
        let isTenantAdmin: boolean = false;
        tenantAdmins['value'].forEach(item => {
            if (item.userPrincipalName === userInfo[0].user.name) {
                isTenantAdmin = true;
            }
        });

        usageDataInfo = {
            Method: ['isUserTenantAdmin'],
            isUserTenantAdmin: [isTenantAdmin],
            Platform: [process.platform],
            Succeeded: [true]
        }
        usageDataHelper.sendUsageDataCustomEvent(usageDataInfo);

        return isTenantAdmin;
    } catch (err) {
        const errorMessage: string = `Unable to determine if user is tenant admin: \n${err}`;
        usageDataHelper.sendUsageDataException('isUserTenantAdmin', errorMessage);
        throw new Error(errorMessage);
    }
}

async function logIntoAzure(): Promise<Object> {
    console.log('Opening browser for authentication to Azure. Enter valid Azure credentials');
    let userJson: Object = await promiseExecuteCommand('az login --allow-no-subscriptions', true /* returnJson */, true /* expectError */);
    if (Object.keys(userJson).length < 1) {
        // Try alternate login
        logoutAzure();
        userJson = await promiseExecuteCommand('az login');
    }
    return userJson
}

async function logoutAzure(): Promise<Object> {
    console.log('Logging out of Azure now');
    return await promiseExecuteCommand('az logout');
}

async function promiseExecuteCommand(cmd: string, returnJson: boolean = true, expectError: boolean = false): Promise<Object | string> {
    return new Promise((resolve, reject) => {
        try {
            childProcess.exec(cmd, { maxBuffer: 1024 * 102400 }, async (err, stdout, stderr) => {
                if (err && !expectError) {
                    console.log(stderr);
                    reject(stderr);
                }
                
                let results = stdout;
                if (results !== '' && returnJson) {
                    results = JSON.parse(results);
                }
                usageDataHelper.sendUsageDataSuccessEvent('promiseExecuteCommand');
                resolve(results);
            });
        } catch (err) {
            usageDataHelper.sendUsageDataException('promiseExecuteCommand', err);
            reject(err);
        }
    });
}

async function setApplicationSecret(applicationJson: Object): Promise<string> {
    try {
        console.log('Setting application secret');
        let azRestCommand: string = await fs.readFileSync(defaults.azRestAddSecretCommandPath, 'utf8');
        azRestCommand = azRestCommand.replace('<App_Object_ID>', applicationJson['id']);
        const secretJson: Object = await promiseExecuteCommand(azRestCommand);
        usageDataHelper.sendUsageDataSuccessEvent('setApplicationSecret');
        return secretJson['secretText'];
    } catch (err) {
        const errorMessage: string = `Unable to set application secret: \n${err}`;
        usageDataHelper.sendUsageDataException('setApplicationSecret', errorMessage);
        throw new Error(errorMessage);
    }
}

async function setIdentifierUri(applicationJson: Object, port: string) {
    try {
        console.log('Setting identifierUri');
        let azRestCommand: string = await fs.readFileSync(defaults.azRestSetIdentifierUriCommmandPath, 'utf8');
        azRestCommand = azRestCommand.replace('<App_Object_ID>', applicationJson['id']).replace('<App_Id>', applicationJson['appId']).replace('{PORT}', port.toString());
        await promiseExecuteCommand(azRestCommand);
        usageDataHelper.sendUsageDataSuccessEvent('setIdentifierUri');
    } catch (err) {
        const errorMessage: string = `Unable to set identifierUri: \n${err}`;
        usageDataHelper.sendUsageDataException('setIdentifierUri', errorMessage);
        throw new Error(errorMessage);
    }
}

async function setSignInAudience(applicationJson: Object) {
    try {
        console.log('Setting signin audience');
        let azRestCommand: string = fs.readFileSync(defaults.azRestSetSigninAudienceCommandPath, 'utf8');
        azRestCommand = azRestCommand.replace('<App_Object_ID>', applicationJson['id']);
        await promiseExecuteCommand(azRestCommand);
        usageDataHelper.sendUsageDataSuccessEvent('setSignInAudience');
    } catch (err) {
        const errorMessage: string = `Unable to set signInAudience: \n${err}`;
        usageDataHelper.sendUsageDataException('setSignInAudience', errorMessage);
        throw new Error(errorMessage);
    }
}

async function setTenantReplyUrls(applicationJson: Object) {
    try {

        let servicePrinicipaObjectlId = "";
        let setReplyUrls: boolean = true;
        const sharePointServiceId: string = "57fb890c-0dab-4253-a5e0-7188c88b2bb4";

        // Get tenant name and construct SharePoint SSO reply urls with tenant name
        let azRestCommand: string = fs.readFileSync(defaults.azRestGetOrganizationDetailsCommandPath, 'utf8');
        const tenantDetails: any = await promiseExecuteCommand(azRestCommand);
        const tenantName: string = tenantDetails.value[0].displayName
        const oneDriveReplyUrl: string = `https://${tenantName}-my.sharepoint.com/_forms/singlesignon.aspx`;
        const sharePointReplyUrl: string = `https://${tenantName}.sharepoint.com/_forms/singlesignon.aspx`;

        // Get service principals for tenant
        azRestCommand = 'az ad sp list --all';
        const servicePrincipals: any = await promiseExecuteCommand(azRestCommand);

        // Check if SharePoint redirects are set for SharePoint principal
        for (let item of servicePrincipals) {
            if (item.appId === sharePointServiceId) {
                servicePrinicipaObjectlId = item.objectId;
                if (item.replyUrls.length === 0) {
                    break;
                    // if there are reply urls set, then we need to see if the SharePoint SSO reply urls are already set
                } else {
                    for (let url of item.replyUrls) {
                        if (url === oneDriveReplyUrl || url === sharePointReplyUrl) {
                            setReplyUrls = false;
                            break;
                        }
                    }
                }

            }
        }

        if (setReplyUrls) {
            console.log('Setting SharePoint reply urls for tenant');
            azRestCommand = fs.readFileSync(defaults.azRestAddTenantReplyUrlsCommandPath, 'utf8');
            const reName = new RegExp('<TENANT-NAME>', 'g');
            azRestCommand = azRestCommand.replace(reName, tenantName).replace('<SP-OBJECTID>', servicePrinicipaObjectlId);
            await promiseExecuteCommand(azRestCommand);
        } else {
            console.log("SharePoint reply urls already set");
        }

        // Send usage data
        usageDataInfo = {
            Method: ['setTenantReplyUrls'],
            tenantReplyUrlsSet: [setReplyUrls],
            Platform: [process.platform],
            Succeeded: [true]
        }
        usageDataHelper.sendUsageDataCustomEvent(usageDataInfo);
    } catch (err) {
        const errorMessage: string = `Unable to set tenant reply urls. \n${err}`;
        usageDataHelper.sendUsageDataException('setTenantReplyUrls', errorMessage);
        throw new Error(errorMessage);
    }
}
