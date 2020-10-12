const AWS = require('aws-sdk');
const ssm = new AWS.SSM();
exports.handler = async(event) => {
    let ouSSMResponse = await ssm.getParameter({ Name: 'oulist' }).promise();
    let ouList = ouSSMResponse.Parameter.Value;
    ouList = ouList.split(",");
    console.log("ouList", ouList);
    console.log("is ouList already an array ?", Array.isArray(ouList));

    var ssmParams = {
        DocumentName: 'Automation-RunScan',
        Parameters: {
            'Operation': ['Scan'],
            'AutomationAssumeRole': ['arn:aws:iam::861664031906:role/AWS-SystemsManager-AutomationAdministrationRole']
        },
        TargetLocations: [{
            Accounts: ouList, // ['ou-e4k3-g2sy60vr', 'ou-e4k3-i998an5p','ou-e4k3-jpejdkd4']
            ExecutionRoleName: 'AWS-SystemsManager-AutomationExecutionRole',
            Regions: ['eu-west-1'],
            TargetLocationMaxErrors: '100%'
        },

        ],
        TargetParameterName: 'InstanceId',
        Targets: [{
            Key: 'InstanceIds',
            Values: [
                '*',
            ]
        },

        ],
    };


    try {
        let data = await ssm.startAutomationExecution(ssmParams).promise();
        console.log(data);

    }
    catch (e) {
        console.error(e);
    }
};
