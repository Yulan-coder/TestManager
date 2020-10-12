const aws = require('aws-sdk');
const docClient = new aws.DynamoDB.DocumentClient();
exports.handler = async (event) => {
    let roleARN = event.ARN;
    console.log("roleARN", roleARN);
    console.log("event.instanceId", event.instanceId);
    await updateEC2RecordInDynamodb(event.instanceId, states.TESTING_INITIATED);

    let sts = new aws.STS({ region: process.env.REGION });
    let stsParams = {
        RoleArn: roleARN,
        RoleSessionName: "awsaccount_session"
    };
    const stsResults = await sts.assumeRole(stsParams).promise();
//    console.log(stsResults);
    let ec2 = new aws.EC2({
        region: process.env.REGION,
        accessKeyId: stsResults.Credentials.AccessKeyId,
        secretAccessKey: stsResults.Credentials.SecretAccessKey,
        sessionToken: stsResults.Credentials.SessionToken
    });

    let ec2Params = {
        Filters: [{
            Name: "resource-id",
            Values: [
                event.instanceId
            ]
        }]
    };
    let ec2TagsResponse = await ec2.describeTags(ec2Params).promise();
//    console.log("ec2TagsResponse", ec2TagsResponse.Tags);
    let tagObjects = ec2TagsResponse.Tags;
    let newTagObjects = [];

    for(let tagObject of tagObjects){

        delete tagObject.ResourceId;
        delete tagObject.ResourceType;

        if(tagObject.Key === "Name")
            continue;
        newTagObjects.push(tagObject);
    }


    let ec2InstanceType = await ec2.describeInstanceAttribute({
        Attribute: "instanceType",
        InstanceId:  event.instanceId
    }).promise();
//    console.log("ec2InstanceType");
    let instanceType = ec2InstanceType.InstanceType;
    let response = {};
    response.Tags = newTagObjects;
    response.InstanceType = instanceType.Value;
    console.log("response", response);
    return response;

};
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
const states = {
    COMPLIANCE_STATUS_RETRIEVED: 'COMPLIANCE_STATUS_RETRIEVED',
    PENDING_MANUAL_APPROVAL_FOR_TESTING: 'PENDING_MANUAL_APPROVAL_FOR_TESTING',
    APPROVED_MANUAL_APPROVAL_FOR_TESTING: 'APPROVED_MANUAL_APPROVAL_FOR_TESTING',
    REJECTED_MANUAL_APPROVAL_FOR_TESTING: 'REJECTED_MANUAL_APPROVAL_FOR_TESTING',
    AUTOMATICALLY_APPROVED_FOR_TESTING: 'AUTOMATICALLY_APPROVED_FOR_TESTING',
    TESTING_INITIATED: 'TESTING_INITIATED',
};