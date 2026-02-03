import click


@click.group("profile")
def action_profile():
    """tools to extract information from profiles"""
    return


@action_profile.command("upgrade")
@click.argument("input", type=click.Path(exists=True))
@click.argument("output", type=click.Path())
def command_update(input, output):
    """upgrade a profile to the latest version"""
    import lnt.testing.profile.profile as profile
    profile.Profile.fromFile(input).upgrade().save(filename=output)


@action_profile.command("getVersion")
@click.argument("input", type=click.Path(exists=True))
def command_get_version(input):
    """print the version of a profile"""
    import lnt.testing.profile.profile as profile
    print(profile.Profile.fromFile(input).getVersion())


@action_profile.command("getTopLevelCounters")
@click.argument("input", type=click.Path(exists=True))
def command_top_level_counters(input):
    """print the whole-profile counter values"""
    import json
    import lnt.testing.profile.profile as profile
    print(json.dumps(profile.Profile.fromFile(input).getTopLevelCounters()))


@action_profile.command("getFunctions")
@click.argument("input", type=click.Path(exists=True))
@click.option("--sortkeys", is_flag=True)
def command_get_functions(input, sortkeys):
    """print the functions in a profile"""
    import json
    import lnt.testing.profile.profile as profile
    print(json.dumps(profile.Profile.fromFile(input).getFunctions(),
                     sort_keys=sortkeys))


@action_profile.command("getCodeForFunction")
@click.argument("input", type=click.Path(exists=True))
@click.argument('fn')
def command_code_for_function(input, fn):
    """print the code/instruction for a function"""
    import json
    import lnt.testing.profile.profile as profile
    print(json.dumps(
        list(profile.Profile.fromFile(input).getCodeForFunction(fn))))
