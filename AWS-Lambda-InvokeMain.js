const aws = require('aws-sdk');
const ssm = new aws.SSM();
const ses = new aws.SES();
const organizations = new aws.Organizations({region: 'us-east-1'});
const lambda = new aws.Lambda();
const util = require('util');
const docClient = new aws.DynamoDB.DocumentClient();
exports.handler = async(event) => {
    let roleARNs = await createRoleArnForChildAccounts();

    //This value will be set if this function is called by the automation document
    if(event.workload){
        let instanceIds = event.instanceIds.split(",");
        let executionResult = await ssm.getAutomationExecution({AutomationExecutionId:event.executionId}).promise();
        let Status = executionResult.AutomationExecution.StepExecutions.find(stepItem => stepItem.StepName === 'WaitForManualApproval').StepStatus;
        if(Status === "Failed") {
            for(let instanceId of instanceIds){
                await updateEC2RecordInDynamodb(instanceId, states.REJECTED_MANUAL_APPROVAL_FOR_TESTING);
            }
        }
        else if(Status === "Success"){
            //update the EC2 states
            for(let instanceId of instanceIds){
                await updateEC2RecordInDynamodb(instanceId, states.APPROVED_MANUAL_APPROVAL_FOR_TESTING);
            }

            //invoke lambda function to create AMI snapshots
            try {
                let ssmAutomationResponse = await ssm.startAutomationExecution(createSSMAutomationDocumentCreateAmiParamsObject(instanceIds, event.accountId, event.workload, getRoleArnForAccount(roleARNs,event.accountId))).promise();
                console.log("ssmAutomationResponse", ssmAutomationResponse);
                let executionResult = await ssm.getAutomationExecution(ssmAutomationResponse).promise();
                console.log("executionResult");
                let ssmManualApprovalAutomation = await ssm.startAutomationExecution(createSSMAutomationDocumentApprovalBeforePatching(instanceIds, event.accountId, getRoleArnForAccount(roleARNs, event.accountId),event.workload)).promise();
                console.log("ssmManualApprovalAutomation", ssmManualApprovalAutomation);
                console.log(util.inspect(executionResult, false, null, true /* enable colors */));
            }
            catch (e) {
                console.error("Error in calling AWS-CreateImage", e);
            }
        }
    }
    else {
        //Lambda is invoked by eventbridge, no parameters
        let resourceComplianceSummaryItemsArray = [];
//Loop through the list of ARNs, asynchronously invoke invoke_secondary lambda and pass ARN
        for (let roleARN of roleARNs) {
            try {
                let lambdaInvokeResponse = await lambda.invoke({
                    FunctionName: "invoke_secondary",
                    InvocationType: 'RequestResponse',
                    Payload: JSON.stringify({ "ARN": roleARN })
                }).promise();

                let resourceComplianceSummaryItems = JSON.parse(lambdaInvokeResponse.Payload).body.ResourceComplianceSummaryItems;

                resourceComplianceSummaryItemsArray.push(...resourceComplianceSummaryItems);
//                console.log("resourceComplianceSummaryItemsArray", resourceComplianceSummaryItemsArray);
            }
            catch (e) {
                console.error("Something went wrong: " + e);
            }

        }

        let accountResourcesDictionary = await createAccountResourcesDictionary(resourceComplianceSummaryItemsArray);
        let workloadResourceDictionary = createWorkloadResourceDictionary(resourceComplianceSummaryItemsArray);

        await sendComplianceReports(accountResourcesDictionary);
        await groupWorkloadAndBeginAutomationExecution(workloadResourceDictionary, roleARNs);

    }




};
async function sendComplianceReports(accountResourcesDictionary){

    let today = getToday(); let date = getDate(today); let time = getTime(today);
    //loop through accountResourcesDictionary to get owner emails and resources, loop through each account owner account ID
    //sort resources by compliance status, format the table for each account id
    //send an email for each account owner with all account id tables
    for (let dictionaryEntry of accountResourcesDictionary) {
        let allAccountTables = '';
        for (let resource of dictionaryEntry.resources) {
            let resourceComplianceSummaryItemsArray = sortBySeverity(resource.resourceComplianceSummaryItems);
            allAccountTables += createAccountTable(resource.accountId, resourceComplianceSummaryItemsArray);
        }

        let sesParams = createSESParamsObject(dictionaryEntry.ownerEmail, createEmailHTML(allAccountTables), date, time);
        let sesResult = await ses.sendEmail(sesParams).promise();
        const response = {
            statusCode: 200,
            body: sesResult,
        };
        console.log(response);
    }

}
async function groupWorkloadAndBeginAutomationExecution(workloadResourceDictionary, roleARNs){
    for(let workloadItem of workloadResourceDictionary){
        let instancesWithState = [];
        for(let instanceId of workloadItem.instanceIds){
            let dbResult = await readEC2RecordFromDynamodb(instanceId);
//            console.log("dbResult", dbResult);
            if(dbResult.status===states.COMPLIANCE_STATUS_RETRIEVED){
                instancesWithState.push(dbResult);
            }

        }
        //If any instances have the mode manual execute manual automation
        if(instancesWithState.find(instanceItem => instanceItem.manualApprovalOrAutomated === 'Manual')){
            for(let instanceId of workloadItem.instanceIds){
                await updateEC2RecordInDynamodb(instanceId, states.PENDING_MANUAL_APPROVAL_FOR_TESTING);
            }

            try {
                //start execution of automation, provide 'manual' as input. It will wait for approval
                let data = await ssm.startAutomationExecution(createSSMAutomationDocumentParamsObject(workloadItem)).promise();
                console.log(data);
            }
            catch (e) {
                console.error(e);
            }

            //TODO on failure it should update the EC2 states and exit
            //TODO create git repo
        }
        else{
            //begin automated execution
            //update EC2 states
            for(let instanceId of workloadItem.instanceIds){
                await updateEC2RecordInDynamodb(instanceId, states.AUTOMATICALLY_APPROVED_FOR_TESTING);
            }
            //call lambda function to create AMI snapshots
            try {
                //              console.log("is instanceIds an array? ", Array.isArray(workloadItem.instanceIds));
                //              console.log("instanceIds", workloadItem.instanceIds);
                let ssmAutomationResponse = await ssm.startAutomationExecution(createSSMAutomationDocumentCreateAmiParamsObject(workloadItem.instanceIds, workloadItem.account,workloadItem.workload, getRoleArnForAccount(roleARNs, workloadItem.account))).promise();
                console.log("ssmAutomationResponse", ssmAutomationResponse);
                let executionResult = await ssm.getAutomationExecution(ssmAutomationResponse).promise();
//                console.log("executionResult");
//                console.log(util.inspect(executionResult, false, null, true /* enable colors */));
                let ssmManualApprovalAutomation = await ssm.startAutomationExecution(createSSMAutomationDocumentApprovalBeforePatching(workloadItem.instanceIds, workloadItem.account, getRoleArnForAccount(roleARNs, workloadItem.account),workloadItem.workload)).promise();
                console.log("ssmManualApprovalAutomation", ssmManualApprovalAutomation);
            }
            catch (e) {
                console.error("Error in calling AWS-CreateImage", e);
            }

        }

    }
}

function createSSMAutomationDocumentApprovalBeforePatching(instanceIds, accountId, roleARN, workloadName ){
    return {
        DocumentName: 'Automation-TestApproval-PatchLiveInstances',
        Parameters: {
            'InstanceIds': [instanceIds.join()],
            'RoleARN': [roleARN],
            'Workload': [workloadName],
            'NotificationArn': [`arn:aws:sns:eu-west-1:${accountId}:Automation-ApprovalRequest`],
            'AutomationAssumeRole': ['arn:aws:iam::<ParentAccountId>:role/AWS-SystemsManager-AutomationAdministrationRole'],
            'Approvers':['arn:aws:iam::<ParentAccountId>:user/approver'],
            'Message':[`Please approve patching for workload ${workloadName} that has the following EC2 instances ${instanceIds} `]
        }
    };
}
function createSSMAutomationDocumentCreateAmiParamsObject(instanceIds, accountId, workloadName, roleARN){
    console.log("instanceIds", instanceIds);
    return {
        DocumentName: 'Automation-CreateAMI-LaunchEC2',
        Parameters: {
            'Workload': [workloadName],
            'RoleARN': [roleARN],
            'AutomationAssumeRole': ['arn:aws:iam::<ParentAccountId>:role/AWS-SystemsManager-AutomationAdministrationRole']
        },
        TargetLocations: [{
            Accounts: [accountId],
            ExecutionRoleName: 'AWS-SystemsManager-AutomationExecutionRole',
            Regions: ['eu-west-1'],
            TargetLocationMaxErrors: '100%'
        },

        ],
        TargetParameterName: 'InstanceId',
        Targets: [{
            Key: 'ParameterValues',
            Values: instanceIds

        },

        ],
    };
}
async function createRoleArnForChildAccounts()
{
    let roleARNs = [];
    let ouSSMResponse = await ssm.getParameter({ Name: 'oulist' }).promise();
    let ouList = ouSSMResponse.Parameter.Value;
    ouList = ouList.split(",");
    let organizationAccountIdArray = [];
    for(let ou of ouList){
        let result = await organizations.listAccountsForParent({ParentId: ou}).promise();
        organizationAccountIdArray.push(result.Accounts);
    }
    organizationAccountIdArray = organizationAccountIdArray.flat().map(organizationAccountObject => parseInt(organizationAccountObject.Id));
    let iamAccessRolesSSMResponse = await ssm.getParameter({ Name: 'iamAccessRole' }).promise();
    let iamAccessRoles = iamAccessRolesSSMResponse.Parameter.Value.split(",");


    for(let organizationAccountId of organizationAccountIdArray){
        roleARNs.push('arn:aws:iam::'+organizationAccountId+':role/'+iamAccessRoles[0]);
    }
    return roleARNs;
}
function createWorkloadResourceDictionary(resourceComplianceSummaryItemsArray){
    let workloadResourceDictionary = [];
    for (let resourceComplianceSummaryItem of resourceComplianceSummaryItemsArray) {

        let workload = resourceComplianceSummaryItem.Tags.find(tagItem => tagItem.Key === 'Workload').Value;
        let indexOfWorkload = workloadResourceDictionary.map(workloadResourceDictionaryItem => workloadResourceDictionaryItem.workload).indexOf(workload);
        if (indexOfWorkload === -1) {
            workloadResourceDictionary.push({
                workload: workload,
                instanceIds: [resourceComplianceSummaryItem.ResourceId],
                account: resourceComplianceSummaryItem.awsAccountId,
            })
        } else {
            workloadResourceDictionary[indexOfWorkload].instanceIds.push(resourceComplianceSummaryItem.ResourceId);
        }
    }
    return workloadResourceDictionary;
}
async function createAccountResourcesDictionary(resourceComplianceSummaryItemsArray){
    let accountResourcesDictionary = [];
    for (let resourceComplianceSummaryItem of resourceComplianceSummaryItemsArray) {

        //add EC2 records to dynamoDB table
        await addEC2RecordToDynamoDb(resourceComplianceSummaryItem);

        for (let ownerEmail of resourceComplianceSummaryItem.ownerEmails) {
            let indexOfOwnerEmail = accountResourcesDictionary.map(accountResourcesDictionaryItem => accountResourcesDictionaryItem.ownerEmail).indexOf(ownerEmail);
            if (indexOfOwnerEmail === -1) {
                accountResourcesDictionary.push({
                    ownerEmail: ownerEmail,
                    resources: [{
                        accountId: resourceComplianceSummaryItem.awsAccountId,
                        resourceComplianceSummaryItems: [resourceComplianceSummaryItem]
                    }]
                });
            }
            else {
                let indexOfAccountId = accountResourcesDictionary[indexOfOwnerEmail].resources.map(resourceItem => resourceItem.accountId).indexOf(resourceComplianceSummaryItem.awsAccountId);
                if (indexOfAccountId === -1) {
                    accountResourcesDictionary[indexOfOwnerEmail].resources.push({
                        accountId: resourceComplianceSummaryItem.awsAccountId,
                        resourceComplianceSummaryItems: [resourceComplianceSummaryItem]
                    });
                }
                else {
                    accountResourcesDictionary[indexOfOwnerEmail].resources[indexOfAccountId].resourceComplianceSummaryItems.push(resourceComplianceSummaryItem);
                }
            }
        }
    }
    return accountResourcesDictionary;
}
function createSSMAutomationDocumentParamsObject(workloadItem){
    return {
        DocumentName: 'Automation-CreatingAMI',
        Parameters: {
            'InstanceIds': [`${workloadItem.instanceIds}`],
            'AccountId': [`${workloadItem.account}`],
            'Workload': [`${workloadItem.workload}`],
            'NotificationArn': [`arn:aws:sns:eu-west-1:${workloadItem.account}:Automation-ApprovalRequest`],
            'Mode': ['Manual'],
            'AutomationAssumeRole': ['arn:aws:iam::<ParentAccountId>:role/AWS-SystemsManager-AutomationAdministrationRole'],
            'Approvers':['arn:aws:iam::<ParentAccountId>:user/approver'],
            'Message':[`Please approve test initialization for workload ${workloadItem.workload} that has the following EC2 instances ${workloadItem.instanceIds} `]
        }
    };
}
function getRoleArnForAccount(roleARNs, accountId){
    return roleARNs.find(roleARN => roleARN.includes(accountId)).toString();
}
async function updateEC2RecordInDynamodb(instanceId, newState){
    try{
        let dbResult = await docClient.update({
            TableName: "TestManagerEC2States",
            Key: {
                "instanceId": instanceId,
            },
            UpdateExpression: "set #s = :r",
            ExpressionAttributeNames:{
                "#s": "status"
            },
            ExpressionAttributeValues:{
                ':r': newState
            },
        }).promise();
        return dbResult;
    }
    catch(error){
        console.error(error);
        throw(error);
    }
}
async function readEC2RecordFromDynamodb(instanceId){
    try{
        let dbResult = await docClient.get({
            TableName: "TestManagerEC2States",
            Key: {
                "instanceId": instanceId,
            }
        }).promise();
        return dbResult.Item;
    }
    catch(error){
        console.error(error);
        throw(error);
    }
}
async function addEC2RecordToDynamoDb(resourceComplianceSummaryItem){
    try{
        let dbResult = await docClient.put({
            TableName: "TestManagerEC2States",
            Item: {
                "instanceId": resourceComplianceSummaryItem.ResourceId,
                "status": states.COMPLIANCE_STATUS_RETRIEVED,
                "statusUpdatedAt": getToday().toLocaleString('en-US', { timeZone: "Asia/Bahrain" }),
                "manualApprovalOrAutomated": resourceComplianceSummaryItem.Tags.find(tagItem => tagItem.Key === 'Mode').Value,
            }
        }).promise();
        return dbResult;
    }
    catch(error){
        console.error(error);
        throw(error);
    }

}
function createEmailHTML(htmlTables) {
    return ('<html><body><style>' +
        'table, th, td {border: 1px solid black; border-collapse: collapse; padding:7px;}' +
        'p{font-size: 15px;}</style>' +
        '<p>Dear Sir/Madam, <br> Please find below your AWS accounts EC2 compliance report.</p>' +
        htmlTables +
        "</body></html>");
}

function createAccountTable(accountId, resourceComplianceSummaryItemsArray) {
    let msg = '<table>' +
        `<tr><th colspan='10'>Account ${accountId}</th></tr>` +
        '<tr><th>Resource ID </th><th>Overall Severity</th> <th>Status </th> ' +
        '<th>Workload</th><th>Operating System </th><th>Mode</th><th>Last Scan At</th>'+
        '<th>Classification</th><th>Severity </th><th>Patch Name</th></tr>';
    for (let resourceComplianceSummaryItem of resourceComplianceSummaryItemsArray) {
        resourceComplianceSummaryItem.Patches = sortByPatchSeverity(resourceComplianceSummaryItem.Patches);
        let rowlength = resourceComplianceSummaryItem.Patches.length;
        msg += `<tr><td rowspan=${rowlength}>` + resourceComplianceSummaryItem.ResourceId + "</td>";
        msg += `<td rowspan=${rowlength}>` + resourceComplianceSummaryItem.OverallSeverity + "</td>";
        msg += `<td style='color:red' rowspan=${rowlength}>` + resourceComplianceSummaryItem.Status + "</td>";
        msg += `<td rowspan=${rowlength}>` + resourceComplianceSummaryItem.Tags.find(tagItem => tagItem.Key === 'Workload').Value + "</td>";
        msg += `<td rowspan=${rowlength}>` + resourceComplianceSummaryItem.operatingSystem + "</td>";
        msg += `<td rowspan=${rowlength}>` + resourceComplianceSummaryItem.Tags.find(tagItem => tagItem.Key === 'Mode').Value + "</td>";
        msg += `<td rowspan=${rowlength}>` + new Date(resourceComplianceSummaryItem.ExecutionSummary.ExecutionTime).toLocaleString('en-GB', { hour12: true}); + "</td>";
        for (let i=0; i<rowlength; i++) {
            if(i>0)
                msg += "<tr>";
            msg += "<td>" + resourceComplianceSummaryItem.Patches[i].Classification + "</td>";
            msg += "<td>" + resourceComplianceSummaryItem.Patches[i].Severity + "</td>";
            msg += "<td>" + resourceComplianceSummaryItem.Patches[i].Title + "</td>";
            if(i>0)
                msg+="</tr>";
        }
        msg+="</tr>";
    }
    msg += "</table> <br>";
    return msg;

}

function sortByPatchSeverity(resourceComplianceSummaryItems) {
    //sort array such that higher severities come before lower ones. Order is CRITICAL > HIGH > MEDIUM > LOW > INFORMATIONAL > UNSPECIFIED
    return resourceComplianceSummaryItems.sort((a, b) => (patchSeverityOrder[a.Severity] - patchSeverityOrder[b.Severity]));

}
function sortBySeverity(resourceComplianceSummaryItems) {
    //sort array such that higher severities come before lower ones. Order is CRITICAL > HIGH > MEDIUM > LOW > INFORMATIONAL > UNSPECIFIED
    return resourceComplianceSummaryItems.sort((a, b) => (severityOrder[a.OverallSeverity] - severityOrder[b.OverallSeverity]));

}

function createSESParamsObject(owner, data, date, time) {
    return {
        Destination: {
            ToAddresses: [owner]
        },
        Message: {
            Body: {
                Html: {
                    Charset: "UTF-8",
                    Data: data
                },
                Text: {
                    Charset: "UTF-8",
                    Data: data
                }
            },
            Subject: {
                Charset: 'UTF-8',
                Data: 'Compliance Report from SSM for ' + date + ' at ' + time
            }
        },
        Source: 'example@123.com'
    };
}

function getToday() {
    let today = new Date();

    return today;
}

function getDate(today) {
    let dateInBahrainTimeZone = new Date(today.toLocaleString('en-US', { timeZone: "Asia/Bahrain" }));

    let date = dateInBahrainTimeZone.getDate() + "/" + (dateInBahrainTimeZone.getMonth() + 1) + "/" + dateInBahrainTimeZone.getFullYear();

    return date;
}

function getTime(today) {
    let dateInBahrainTimeZone = new Date(today.toLocaleString('en-US', { timeZone: "Asia/Bahrain" }));

    let ampm = (dateInBahrainTimeZone.getHours() < 12) ? 'AM' : 'PM';

    let time = (dateInBahrainTimeZone.getHours() - 12 < 0 ? dateInBahrainTimeZone.getHours() : ((dateInBahrainTimeZone.getHours() - 12 > 0) ? dateInBahrainTimeZone.getHours() - 12 : 12)) + ":" + (dateInBahrainTimeZone.getMinutes() < 10 ? '0' : '') + dateInBahrainTimeZone.getMinutes() + ' ' + ampm;

    return time;
}

const states = {
    COMPLIANCE_STATUS_RETRIEVED: 'COMPLIANCE_STATUS_RETRIEVED',
    PENDING_MANUAL_APPROVAL_FOR_TESTING: 'PENDING_MANUAL_APPROVAL_FOR_TESTING',
    APPROVED_MANUAL_APPROVAL_FOR_TESTING: 'APPROVED_MANUAL_APPROVAL_FOR_TESTING',
    REJECTED_MANUAL_APPROVAL_FOR_TESTING: 'REJECTED_MANUAL_APPROVAL_FOR_TESTING',
    AUTOMATICALLY_APPROVED_FOR_TESTING: 'AUTOMATICALLY_APPROVED_FOR_TESTING',
    TESTING_INITIATED: 'TESTING_INITIATED',
}
const severityOrder = {
    CRITICAL: 1,
    HIGH: 2,
    MEDIUM: 3,
    LOW: 4,
    INFORMATIONAL: 5,
    UNSPECIFIED:6
}
const patchSeverityOrder = {
    Critical: 1,
    Important: 2,
    Moderate: 3,
    Medium: 4,
    Low: 5,
    Unspecified:6
}