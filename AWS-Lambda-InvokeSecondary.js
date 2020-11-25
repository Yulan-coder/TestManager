const aws = require('aws-sdk');
const util = require('util');
exports.handler = async(event) => {
    let roleARN = event.ARN;
    console.log("roleARN", roleARN);

    //initiating a session using ARN of the IAM role

    let sts = new aws.STS({ region: process.env.REGION });
    let stsParams = {
        RoleArn: roleARN,
        RoleSessionName: "awsaccount_session"
    };
    const stsResults = await sts.assumeRole(stsParams).promise();
    console.log(stsResults);
    let ec2 = new aws.EC2({
        region: process.env.REGION,
        accessKeyId: stsResults.Credentials.AccessKeyId,
        secretAccessKey: stsResults.Credentials.SecretAccessKey,
        sessionToken: stsResults.Credentials.SessionToken
    });

    let ssm = new aws.SSM({
        region: process.env.REGION,
        accessKeyId: stsResults.Credentials.AccessKeyId,
        secretAccessKey: stsResults.Credentials.SecretAccessKey,
        sessionToken: stsResults.Credentials.SessionToken
    });

    let ssmParams = {
        Filters: [{
            Key: "ComplianceType",
            Type: "EQUAL",
            Values: [
                "Patch"
            ]
        },
            {
                Key: "Status",
                Type: "EQUAL",
                Values: [
                    "NON_COMPLIANT"
                ]
            },
        ],
    };


    let res = await ssm.listResourceComplianceSummaries(ssmParams).promise();

    for (let i = 0; i < res.ResourceComplianceSummaryItems.length; i++) {
        let ec2Params = {
            Filters: [{
                Name: "resource-id",
                Values: [
                    res.ResourceComplianceSummaryItems[i].ResourceId
                ]
            }]
        };

        let ssmInfoParams = {
            Filters: [{
                Key: "InstanceIds",
                Values: [
                    res.ResourceComplianceSummaryItems[i].ResourceId
                ]
            }]
        };

        let ssmPatchParams = {
            InstanceId: res.ResourceComplianceSummaryItems[i].ResourceId,
            Filters: [
                {
                    Key: 'State',
                    Values: [
                        'Missing'

                    ]
                },

            ],
        };

        let ec2TagsResponse = await ec2.describeTags(ec2Params).promise();
        let instanceInfo = await ssm.describeInstanceInformation(ssmInfoParams).promise();
        let instancePatchInfo = await ssm.describeInstancePatches(ssmPatchParams).promise();

        res.ResourceComplianceSummaryItems[i].Tags = ec2TagsResponse.Tags;
        res.ResourceComplianceSummaryItems[i].awsAccountId = getAcountId(roleARN);
        res.ResourceComplianceSummaryItems[i].operatingSystem = instanceInfo.InstanceInformationList[0].PlatformType;
        res.ResourceComplianceSummaryItems[i].Patches = instancePatchInfo.Patches;
        let ownerEmailsArray = ec2TagsResponse.Tags.filter(tag => tag.Key === "ssmpatching.owner").map(tag => tag.Value.split(",")).flat().map(ownerEmail => ownerEmail.trim());
        ownerEmailsArray = [...new Set(ownerEmailsArray)];
        res.ResourceComplianceSummaryItems[i].ownerEmails = ownerEmailsArray;
    }

    console.log("res", res);

    const response = {
        statusCode: 200,
        body: res,
    };

    return response;

};
function getAcountId(roleARN){
    return roleARN.substring(roleARN.lastIndexOf("::") + 2, roleARN.lastIndexOf(":role/"));
}
